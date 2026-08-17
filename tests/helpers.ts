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
  commonTestUrl?: string;
  commonBuildUrl?: string;
  fsRoot?: string;
  orch?: unknown;
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