import { createHash } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import {
  artifactFileName as buildArtifactFileName,
  defaultArtifactTemplates,
} from "../../artifacts.js";
import type { ParsedArtifact, RepoAdapter } from "../../repoAdapter.js";
import type { DatabaseClient } from "../../db/index.js";
import { packages, repositories } from "../../db/schema.js";

export function sha256(data: string | Uint8Array): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  // Вес файла входит в хэш: одинаковое содержимое разной длины — разный хэш,
  // а бинарные артефакты хэшируются по байтам, не по utf8-строке.
  const weight = Buffer.allocUnsafe(8);
  weight.writeBigUInt64LE(BigInt(buf.length));
  return createHash("sha256").update(weight).update(buf).digest("hex");
}

/** Имя файла для размещения в репозитории по шаблону пакетной системы типа. */
export function artifactFileName(name: string, version: string, type: string): string {
  const template = defaultArtifactTemplates[type] ?? defaultArtifactTemplates.rpm!;
  return buildArtifactFileName(name, version, template);
}

export function repositoryByIdentity(db: DatabaseClient, name: string) {
  return db.select().from(repositories).where(eq(repositories.name, name)).get();
}

export function getPackage(db: DatabaseClient, name: string) {
  return db.select().from(packages).where(eq(packages.name, name)).get();
}

/** Создаёт пакет, если его нет, и возвращает запись. */
export function ensurePackage(
  db: DatabaseClient,
  name: string,
  repositoriesList: string[],
  createdAt: Date,
) {
  let real = getPackage(db, name);
  if (!real) {
    db.insert(packages)
      .values({
        name,
        repositories: repositoriesList,
        createdAt,
      })
      .run();
    real = getPackage(db, name)!;
  }
  return real;
}

export function reposOf(
  db: DatabaseClient,
  pkg: { repositories: string[] },
): Array<{ name: string; path: string; type: string }> {
  return pkg.repositories
    .map((name) => repositoryByIdentity(db, name))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
}

/** Ошибка разбора артефакта при размещении через API (в отличие от sync — ошибка, не лог). */
export class ArtifactError extends Error {
  constructor(
    public readonly code: string,
    /** Фактическое имя/версия из метаданных file — возвращается клиенту как ожидаемое. */
    public readonly derived?: ParsedArtifact,
  ) {
    super(code);
  }
}

export function isArtifactError(error: unknown): error is ArtifactError {
  return error instanceof ArtifactError;
}

/**
 * Запись файла в каждый репозиторий под заданным именем/версией
 * (без разбора — используется для переразмещения уже известных файлов).
 */
export async function writeFileToRepos(
  db: DatabaseClient,
  pkg: { repositories: string[] },
  name: string,
  version: string,
  content: Uint8Array,
  adapter?: RepoAdapter,
): Promise<void> {
  for (const repo of reposOf(db, pkg)) {
    const target = join(repo.path, artifactFileName(name, version, repo.type));
    await mkdir(repo.path, { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content);
    await rename(tmp, target);
    if (adapter) {
      await adapter.update(repo.path, repo.type, name, version);
    }
  }
}

/**
 * Разбор загружаемого файла той же цепочкой, что и в синке: утилита пакетной
 * системы по содержимому, фолбэк — парсер имени файла по шаблону.
 * filename — имя загружаемого файла (нужно фолбэк-парсеру; это имя ФАЙЛА,
 * а не пакета). undefined — файл не разобран.
 */
export async function parseUpload(
  adapter: RepoAdapter,
  content: Uint8Array,
  filename?: string,
): Promise<ParsedArtifact | undefined> {
  const probeDir = join(tmpdir(), `.wm-probe-${process.pid}-${Date.now()}`);
  await mkdir(probeDir, { recursive: true });
  const base = filename && filename.length > 0 ? basename(filename) : "package.rpm";
  const probe = join(probeDir, base);
  await writeFile(probe, content);
  try {
    return await adapter.inspect("rpm", probe);
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

export async function removeArtifactFromRepos(
  db: DatabaseClient,
  pkg: { repositories: string[] },
  name: string,
  version: string,
): Promise<void> {
  for (const repo of reposOf(db, pkg)) {
    try {
      await rm(join(repo.path, artifactFileName(name, version, repo.type)), { force: true });
    } catch {
      // File not present — nothing to remove.
    }
  }
}

/** Наличие файла в одном из репозиториев пакета (для ленивого индекса). */
export async function artifactExistsInRepos(
  db: DatabaseClient,
  pkg: { repositories: string[] },
  name: string,
  version: string,
): Promise<boolean> {
  for (const repo of reposOf(db, pkg)) {
    try {
      await access(join(repo.path, artifactFileName(name, version, repo.type)), fsConstants.F_OK);
      return true;
    } catch {
      // not in this repo
    }
  }
  return false;
}