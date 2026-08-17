import { createHash } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
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

/** Создаёт пакет, если его нет, и возвращает запись (для привязки к фактическому имени). */
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
        testUrl: null,
        buildUrl: null,
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

/** Ответ для ошибок размещения: код + фактические имя/версия из метаданных. */
export function artifactErrorResponse(c: Context, error: ArtifactError) {
  return c.json(
    error.derived
      ? { error: error.code, name: error.derived.name, version: error.derived.version }
      : { error: error.code },
    400,
  );
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
 * Размещение артефакта через API: контент записывается во временный файл,
 * имя и версия определяются той же цепочкой утилит, что и в синке (фолбэк —
 * только проверка шаблона составленного имени, не слепое согласие с телом).
 */
export async function writeArtifactToRepos(
  db: DatabaseClient,
  pkg: { repositories: string[] },
  name: string,
  version: string,
  content: Uint8Array,
  adapter: RepoAdapter,
  resolveName = false,
): Promise<ParsedArtifact> {
  const repo = reposOf(db, pkg)[0];
  if (!repo) throw new ArtifactError("no_repositories");
  // Временный файл называется артефактным именем — для разбора той же цепочкой
  // (фолбэк-парсер работает по базовому имени); уникальность — через директорию.
  const probeDir = join(tmpdir(), `.wm-probe-${process.pid}-${Date.now()}`);
  await mkdir(probeDir, { recursive: true });
  const probe = join(probeDir, artifactFileName(name, version, repo.type));
  await writeFile(probe, content);
  let parsed: ParsedArtifact | undefined;
  try {
    parsed = await adapter.inspect(repo.type, probe);
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
  // resolveName: сервер переименовывает файл под фактическое имя/версию (PRS-07).
  if (!parsed) throw new ArtifactError("artifact_unparseable");
  if (parsed.name !== name && !resolveName) {
    throw new ArtifactError("artifact_name_mismatch", parsed);
  }
  await writeFileToRepos(db, pkg, parsed.name, parsed.version, content, adapter);
  return parsed;
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