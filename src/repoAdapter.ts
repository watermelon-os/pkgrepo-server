import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  artifactFileName,
  defaultArtifactTemplates,
  parseArtifactName,
  type ParsedArtifact,
} from "./artifacts.js";
import type { Logger } from "./logger.js";

export type { ParsedArtifact };

export interface ExecResult {
  stdout: string;
  code: number;
}

export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface RepoAdapterOptions {
  /** Разбирать артефакты утилитами пакетной системы (иначе — только парсер имени файла). */
  useUtilities: boolean;
  logger?: Logger;
  /** Инъекция запуска процессов (для тестов). */
  exec?: ExecFn;
}

export interface RepoAdapter {
  isInitialized?: (dir: string, type: string) => boolean;
  inspect: (type: string, filePath: string) => Promise<ParsedArtifact | undefined>;
  update: (name: string, version?: string) => void | Promise<void>;
}

/** Бинарники инструментов находятся через PATH (`/usr/bin/env`). */
function defaultExec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/env", [cmd, ...args], { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        // Строковый code — сбой запуска (ENOENT и т.д.); число — процесс выполнился с ошибкой.
        if (typeof error.code === "string") reject(error);
        else resolve({ stdout, code: typeof error.code === "number" ? error.code : 1 });
      } else {
        resolve({ stdout, code: 0 });
      }
    });
  });
}

/** Кандидат на разбор утилитой: команда (через /usr/bin/env) и разбор вывода. */
interface PackageInspector {
  command: string[];
  parse: (stdout: string) => ParsedArtifact | undefined;
}

/** Первое вхождение ключа (для архивов с несколькими PKGBUILD). */
function firstWins(
  lines: string[],
  parseLine: (line: string) => [string, string] | undefined,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const pair = parseLine(line);
    if (pair && fields[pair[0]] === undefined) fields[pair[0]] = pair[1];
  }
  return fields;
}

function parseKeyEquals(line: string): [string, string] | undefined {
  const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line.trim());
  if (!match) return undefined;
  const value = match[2]!.trim();
  if (value.startsWith("(")) {
    const quoted = /['"]([^'"]*)['"]/.exec(value);
    return [match[1]!, quoted ? quoted[1]! : ""];
  }
  return [match[1]!, value.replace(/['"]/g, "").trim()];
}

/** Разбор вывода утилиты в имя и версию (архитектура/релиз — часть версии). */
function parseRpm(stdout: string): ParsedArtifact | undefined {
  const [name, version] = stdout.trim().split("\n").map((s) => s.trim());
  if (!name || !version) return undefined;
  return { name, version };
}

function parseDeb(stdout: string): ParsedArtifact | undefined {
  const [name, versionPart, arch] = stdout.trim().split("\n").map((s) => s.trim());
  if (!name || !versionPart || !arch) return undefined;
  return { name, version: `${versionPart}_${arch}` };
}

/** deb через `dpkg --info`: блок `Package:`/`Version:`/`Architecture:`. */
function parseDpkgInfo(stdout: string): ParsedArtifact | undefined {
  const fields: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = /^(Package|Version|Architecture):\s*(.+)$/.exec(line.trim());
    if (match && fields[match[1]!] === undefined) fields[match[1]!] = match[2]!.trim();
  }
  const name = fields.Package;
  const versionPart = fields.Version;
  const arch = fields.Architecture;
  if (!name || !versionPart || !arch) return undefined;
  return { name, version: `${versionPart}_${arch}` };
}

/** Собранный pacman-пакет: `.PKGINFO` (pkgname/pkgver/arch). */
function parsePkgInfo(stdout: string): ParsedArtifact | undefined {
  const fields = firstWins(stdout.trim().split("\n"), (line) => {
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line.trim());
    return match ? [match[1]!, match[2]!.trim()] : undefined;
  });
  const name = fields.pkgname;
  const pkgver = fields.pkgver;
  const arch = fields.arch;
  if (!name || !pkgver || !arch) return undefined;
  return { name, version: `${pkgver}-${arch}` };
}

/** Исходный архив pacman: `PKGBUILD` (pkgname/pkgver/pkgrel/arch). */
function parsePkgbuild(stdout: string): ParsedArtifact | undefined {
  const fields = firstWins(stdout.trim().split("\n"), parseKeyEquals);
  const name = fields.pkgname;
  const pkgver = fields.pkgver;
  const pkgrel = fields.pkgrel;
  const arch = fields.arch;
  if (!name || !pkgver || !pkgrel || !arch) return undefined;
  return { name, version: `${pkgver}-${pkgrel}-${arch}` };
}

/** Кандидаты-утилиты для типа репозитория (порядок: попытка по очереди). */
function inspectorsFor(type: string, filePath: string): PackageInspector[] | undefined {
  switch (type) {
    case "rpm":
      return [
        {
          command: ["rpm", "-qp", "--qf", "%{NAME}\n%{VERSION}-%{RELEASE}.%{ARCH}", filePath],
          parse: parseRpm,
        },
      ];
    case "deb":
      return [
        {
          command: ["dpkg-deb", "-f", filePath, "Package", "Version", "Architecture"],
          parse: parseDeb,
        },
        {
          command: ["dpkg", "--info", filePath],
          parse: parseDpkgInfo,
        },
      ];
    case "pacman":
      return [
        {
          command: ["tar", "-xOf", filePath, ".PKGINFO"],
          parse: parsePkgInfo,
        },
        {
          command: ["tar", "-xOf", filePath, "--wildcards", "*/PKGBUILD"],
          parse: parsePkgbuild,
        },
      ];
    default:
      return undefined;
  }
}

/**
 * Разбор артефакта: утилиты пакетной системы по очереди (если включено в конфиге),
 * затем фолбэк — парсер имени файла по шаблону.
 */
export async function inspectPackage(
  type: string,
  filePath: string,
  options: RepoAdapterOptions,
): Promise<ParsedArtifact | undefined> {
  if (options.useUtilities) {
    const inspectors = inspectorsFor(type, filePath);
    if (inspectors) {
      const exec = options.exec ?? defaultExec;
      let warned = false;
      for (const inspector of inspectors) {
        const [tool, ...args] = inspector.command;
        let result: ExecResult;
        try {
          result = await exec(tool!, args ?? []);
        } catch (error) {
          // Утилита не найдена/не выполнилась — варнинг (один раз) и следующая попытка.
          if (!warned) {
            warned = true;
            options.logger?.warn("inspect: package utility unavailable", {
              type,
              tool,
              file: filePath,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          continue;
        }
        if (result.code !== 0) continue;
        const parsed = inspector.parse(result.stdout);
        if (parsed) return parsed;
        // Утилита выполнилась, но файл — не пакет: следующая попытка.
      }
    }
  }
  return fallbackParse(type, filePath);
}

function fallbackParse(type: string, filePath: string): ParsedArtifact | undefined {
  const template = defaultArtifactTemplates[type];
  if (!template) return undefined;
  return parseArtifactName(basename(filePath), template);
}

/** Проверка проинициализированности репозитория маркерами формата. */
export function isRepoInitialized(dir: string, type: string): boolean {
  try {
    if (type === "rpm") {
      return statSync(join(dir, "repodata")).isDirectory();
    }
    if (type === "deb") {
      return existsSync(join(dir, "Packages")) || existsSync(join(dir, "Release"));
    }
    return false;
  } catch {
    return false;
  }
}

export function createRepoAdapter(options: RepoAdapterOptions): RepoAdapter {
  return {
    isInitialized: isRepoInitialized,
    inspect: (type, filePath) => inspectPackage(type, filePath, options),
    update: async (name, version) => {
      // Обновление бд репозитория специфичной командой — вне этого шага (см. очередь).
      options.logger?.debug("repository update", { name, version });
    },
  };
}

// artifactFileName используется производным кодом для размещения файлов.
export { artifactFileName };