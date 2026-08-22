import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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
  update: (dir: string, type: string, name: string, version?: string) => void | Promise<void>;
  init?: (dir: string, type: string) => Promise<void>;
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

/** Разбор вывода утилиты в имя и версию (архитектура/релиз — часть версии). */
function parseRpm(stdout: string): ParsedArtifact | undefined {
  const [name, version] = stdout.trim().split("\n").map((s) => s.trim());
  if (!name || !version) return undefined;
  return { name, version };
}

/** Кандидаты-утилиты для типа репозитория. */
function inspectorsFor(type: string, filePath: string): PackageInspector[] | undefined {
  switch (type) {
    case "rpm":
      return [
        {
          command: ["rpm", "-qp", "--qf", "%{NAME}\n%{VERSION}-%{RELEASE}.%{ARCH}", filePath],
          parse: parseRpm,
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
    return false;
  } catch {
    return false;
  }
}

/**
 * Инициализация репозитория: создание каталога и маркеров формата.
 * Индекс (repodata/repomd.xml) перестраивается при добавлении артефактов
 * через adapter.update.
 */
export async function initRepo(dir: string, type: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (type === "rpm") {
    await mkdir(join(dir, "repodata"), { recursive: true });
  }
}

/** Команды генерации бд репозитория по типу (в порядке попыток). */
function generatorCommandsFor(
  dir: string,
  type: string,
  name: string,
  version: string | undefined,
): Array<{ command: string[] }> {
  switch (type) {
    case "rpm":
      void name;
      void version;
      return [{ command: ["createrepo_c", dir] }, { command: ["createrepo", dir] }];
    default:
      return [];
  }
}

/** Запуск генератора бд репозитория; отсутствующая утилита — варнинг и следующая попытка. */
async function updateRepoDb(
  dir: string,
  type: string,
  name: string,
  version: string | undefined,
  options: RepoAdapterOptions,
): Promise<void> {
  const commands = generatorCommandsFor(dir, type, name, version);
  if (commands.length === 0) {
    options.logger?.warn("repo update: no generator for repository", { dir, type, name });
    return;
  }
  const exec = options.exec ?? defaultExec;
  let warned = false;
  for (const { command } of commands) {
    const [tool, ...args] = command;
    let result: ExecResult;
    try {
      result = await exec(tool!, args ?? []);
    } catch (error) {
      if (!warned) {
        warned = true;
        options.logger?.warn("repo update: generator unavailable", {
          type,
          tool,
          dir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    if (result.code !== 0) continue;
    options.logger?.debug("repo update done", { type, tool, dir, name, version });
    return;
  }
  options.logger?.warn("repo update: no generator succeeded", { type, dir, name });
}

export function createRepoAdapter(options: RepoAdapterOptions): RepoAdapter {
  return {
    isInitialized: isRepoInitialized,
    inspect: (type, filePath) => inspectPackage(type, filePath, options),
    update: (dir, type, name, version) => updateRepoDb(dir, type, name, version, options),
    init: initRepo,
  };
}

// artifactFileName используется производным кодом для размещения файлов.
export { artifactFileName };
