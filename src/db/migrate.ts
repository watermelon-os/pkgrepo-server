import { resolve } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { loadConfig } from "../config.js";
import { openDb } from "./index.js";
import { createLogger, type Logger } from "../logger.js";

// Миграции лежат рядом с кодом (drizzle/ в корне пакета), а не в cwd — cwd
// сервиса (systemd) может не быть каталогом установки.
const defaultMigrationsFolder = resolve(import.meta.dirname, "../../drizzle");

export async function runMigrations(
  dbPath: string,
  migrationsFolder: string = defaultMigrationsFolder,
  logger: Logger = createLogger({ level: "info" }),
): Promise<void> {
  const { db, sqlite } = await openDb(dbPath);
  try {
    migrate(db, { migrationsFolder });
  } finally {
    sqlite.close();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, name: "watermelon-server-ts" });
  logger.info("applying migrations", { database: config.DATABASE_PATH });
  await runMigrations(config.DATABASE_PATH, undefined, logger);
  logger.info("migrations applied");
}

if (import.meta.main) {
  await main();
}
