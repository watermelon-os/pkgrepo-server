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
  return { app, db, sqlite };
}

describe("GET /api/health", () => {
  it("reports ok with version and uptime", async () => {
    const { app } = makeApp("1.2.3");
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      version: "1.2.3",
      uptimeSeconds: 0,
    });
  });

  it("reports database connectivity", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/health/db");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: "ok" });
  });
});

describe("app_meta key/value API", () => {
  it("returns 404 for a missing key", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/meta/missing");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("creates, reads and updates a key", async () => {
    const { app } = makeApp();
    const put = await app.request("/api/meta/foo", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "bar" }),
    });
    expect(put.status).toBe(201);
    expect(await put.json()).toEqual({ key: "foo", value: "bar" });

    const get = await app.request("/api/meta/foo");
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ key: "foo", value: "bar" });

    const update = await app.request("/api/meta/foo", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "baz" }),
    });
    expect(update.status).toBe(201);
    expect(await update.json()).toEqual({ key: "foo", value: "baz" });
  });

  it("rejects invalid keys and bodies", async () => {
    const { app } = makeApp();
    const badKey = await app.request("/api/meta/bad key!");
    expect(badKey.status).toBe(400);

    const badBody = await app.request("/api/meta/ok", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 42 }),
    });
    expect(badBody.status).toBe(400);
  });
});

describe("routing", () => {
  it("returns JSON 404 for unknown API routes", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
