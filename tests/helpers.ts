import { resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createApp, type AppDeps } from "../src/app.js";
import type { DatabaseClient } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import { createLogger, type Logger, type LogFields, type LogLevel } from "../src/logger.js";

export interface MakeAppOptions {
  db?: DatabaseClient;
  version?: string;
  startedAt?: number;
  logger?: Logger;
  fsRoot?: string;
  logEmptySync?: boolean;
  tokens?: Array<{ value: string; comment?: string; role?: string }>;
}

export interface TestContext {
  app: ReturnType<typeof createApp>;
  db: DatabaseClient;
  sqlite: Database.Database;
}

export function makeApp(options: MakeAppOptions = {}): TestContext {
  const sqlite = new Database(":memory:");
  const db: DatabaseClient = options.db ?? drizzle(sqlite, { schema });
  if (!options.db) {
    migrate(db, { migrationsFolder: resolve(import.meta.dirname, "../drizzle") });
  }
  const app = createApp({
    db,
    version: options.version ?? "0.0.0-test",
    startedAt: options.startedAt ?? Date.now(),
    ...options,
  } as unknown as AppDeps);
  return { app, db, sqlite };
}

/** Логгер, собирающий строки в память, для проверки логов. */
export function memoryLogger(level: LogLevel = "debug"): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    name: "test",
    stream: { write: (line) => lines.push(line) },
  });
  // у child() общий stream — строки попадают в lines
  void logger.child({});
  void ({} as LogFields);
  return { logger, lines };
}

export function json(
  app: ReturnType<typeof makeApp>["app"],
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  return app.request(url, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** PRS-07: бинарная загрузка — body = байты файла, метаданные — в query. */
export function binary(
  app: ReturnType<typeof makeApp>["app"],
  url: string,
  init: { method?: string; body?: Uint8Array; headers?: Record<string, string> } = {},
) {
  return app.request(url, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/octet-stream",
      ...(init.headers ?? {}),
    },
    body: init.body,
  });
}

/** Создаёт rpm-репозиторий (проинициализированная директория + POST /api/repos). */
export async function seedRepo(
  app: ReturnType<typeof makeApp>["app"],
  name = "a",
): Promise<string> {
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = mkdtempSync(join(tmpdir(), "wm-test-"));
  mkdirSync(join(path, "repodata"), { recursive: true });
  const res = await json(app, "/api/repos", {
    method: "POST",
    body: { name, path, type: "rpm" },
  });
  if (res.status !== 201) throw new Error(`seedRepo failed: ${res.status}`);
  return path;
}

/** Создаёт пакет с версией и файлом (или добавляет версию к существующему имени). */
export async function seedPackage(
  app: ReturnType<typeof makeApp>["app"],
  name: string,
  version: string,
  repo = "a",
): Promise<void> {
  const file = `artifact:${name}:${version}`;
  // Имя пакета в запросе не задается: разбирается из имени файла (NM-06).
  const filename = `${name}-${version}.rpm`;
  const res = await json(app, "/api/packages", {
    method: "POST",
    body: { filename, repositories: [repo], file },
  });
  if (res.status === 201) return;
  if (res.status !== 409) throw new Error(`seedPackage failed: ${res.status}`);
  const add = await json(app, `/api/packages/${name}/versions`, {
    method: "POST",
    body: { filename, file },
  });
  if (add.status !== 201) throw new Error(`seedPackage (add version) failed: ${add.status}`);
}

/** Текст спека с тегами Name/Version/Release. */
export function makeSpecText(name: string, version: string, release = "1"): string {
  return [
    `Name:           ${name}`,
    `Version:        ${version}`,
    `Release:        ${release}`,
    "Summary:        Test spec",
    "",
    "%description",
    "Test spec body",
    "",
  ].join("\n");
}

/** Загружает спек (создает имя при необходимости). Имя разбирается из содержимого. */
export async function seedSpec(
  app: ReturnType<typeof makeApp>["app"],
  name: string,
  version = "1.0.0",
  release = "1",
): Promise<void> {
  const res = await json(app, "/api/specs", {
    method: "POST",
    body: { file: makeSpecText(name, version, release) },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`seedSpec failed: ${res.status}`);
  }
}