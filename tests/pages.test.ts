import { resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app.js";
import type { DatabaseClient } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";

function makeApp(version = "0.0.0-test") {
  const sqlite = new Database(":memory:");
  const db: DatabaseClient = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(import.meta.dirname, "../drizzle") });
  const app = createApp({ db, version, startedAt: Date.now() });
  return { app };
}

describe("SSR pages (Hono JSX)", () => {
  it("serves the index page as HTML", async () => {
    const { app } = makeApp("9.9.9");
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Watermelon Server (TypeScript)");
    expect(html).toContain("9.9.9");
  });

  it("renders API links on the index page", async () => {
    const { app } = makeApp();
    const res = await app.request("/");
    const html = await res.text();
    expect(html).toContain("/api/health");
    expect(html).toContain("/api/health/db");
  });
});
