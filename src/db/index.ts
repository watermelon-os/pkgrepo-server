import { mkdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type DatabaseClient = BetterSQLite3Database<typeof schema>;

export interface OpenDbResult {
  db: DatabaseClient;
  sqlite: Database.Database;
}

export async function openDb(dbPath: string): Promise<OpenDbResult> {
  const dir = path.dirname(dbPath);
  await mkdir(dir, { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
