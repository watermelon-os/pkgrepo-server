import { resolve } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { loadConfig } from "../config.js";
import { openDb } from "./index.js";

export async function runMigrations(
  dbPath: string,
  migrationsFolder: string = resolve(process.cwd(), "drizzle"),
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
  console.log(`[watermelon-server-ts] applying migrations to ${config.DATABASE_PATH}`);
  await runMigrations(config.DATABASE_PATH);
  console.log("[watermelon-server-ts] migrations applied");
}

if (import.meta.main) {
  await main();
}
