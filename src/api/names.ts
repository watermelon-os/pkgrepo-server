import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Hono, type Context } from "hono";
import { specs } from "../db/schema.js";
import { createLogger, type Logger } from "../logger.js";
import type { DatabaseClient } from "../db/index.js";
import { parseSpecContent } from "../specs.js";
import { ensurePackage, sha256 } from "./packages/artifacts.js";

export interface NamesApiDeps {
  db: DatabaseClient;
  logger?: Logger;
}

const specBodySchema = z.object({
  file: z.string().optional(),
  override: z.boolean().optional(),
});

// Бинарная загрузка — тело считается файлом для любого content-type,
// кроме явного application/json.
function isJsonRequest(c: Context): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
}

function queryBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === "true" || v === "1";
}

export function namesRoutes(deps: NamesApiDeps): Hono {
  const db = deps.db;

  const app = new Hono();

  // Список спеков имени.
  app.get("/:name/specs", (c) => {
    const name = c.req.param("name");
    const rows = db.select().from(specs).where(eq(specs.name, name)).all();
    return c.json({
      name,
      specs: rows.map((row) => ({
        version: row.version,
        sha256: row.sha256,
        createdAt: row.createdAt,
      })),
    });
  });

  // Скачивание спека по его версии.
  app.get("/:name/specs/:version", (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    const row = db
      .select()
      .from(specs)
      .where(and(eq(specs.name, name), eq(specs.version, version)))
      .get();
    if (!row) return c.json({ error: "not_found" }, 404);
    c.header("content-type", "text/plain; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${name}-${row.version}.spec"`);
    return c.body(row.content);
  });

  return app;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`.*${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}.*`);
}

/**
 * Загрузка и поиск спеков (/api/specs). Имя НЕ задается в запросе —
 * разбирается из содержимого спека (NM-06); дедуп по хэшу содержимого
 * (+имя+версия спека); override — перезапись записи на месте.
 */
export function specsSearchRoutes(deps: NamesApiDeps): Hono {
  const db = deps.db;
  const logger = deps.logger ?? createLogger({ level: "info" });

  const app = new Hono();

  // NM-01. Загрузка спека: создает имя при его отсутствии.
  app.post("/", async (c) => {
    const reqId = c.get("reqId");
    let content: Uint8Array | undefined;
    let override: boolean | undefined;
    try {
      if (isJsonRequest(c)) {
        const body = specBodySchema.parse(await c.req.json());
        if (body.file !== undefined) content = Buffer.from(body.file, "utf8");
        override = body.override;
      } else {
        const bytes = await c.req.arrayBuffer();
        content = bytes.byteLength > 0 ? new Uint8Array(bytes) : undefined;
        override = queryBool(c.req.query("override"));
      }
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (content === undefined) return c.json({ error: "file_required" }, 400);

    const text = Buffer.from(content).toString("utf8");
    const parsed = parseSpecContent(text);
    if (!parsed) {
      // NM-05: невалидный спек — ошибка, имя не создается.
      return c.json({ error: "invalid_spec" }, 400);
    }

    const now = new Date();
    ensurePackage(db, parsed.name, [], now);

    const hash = sha256(content);
    const existing = db
      .select()
      .from(specs)
      .where(and(eq(specs.name, parsed.name), eq(specs.version, parsed.version)))
      .get();
    if (existing) {
      if (override !== true) {
        // NM-03: дубль без override — ошибка.
        return c.json(
          { error: "spec_exists", name: parsed.name, version: parsed.version },
          409,
        );
      }
      // NM-03 override: перезапись «втупую», id неизменен — ссылки не ломаются.
      db.update(specs)
        .set({ sha256: hash, content: text })
        .where(eq(specs.id, existing.id))
        .run();
      logger.info("spec overridden", { req_id: reqId, name: parsed.name, version: parsed.version });
      return c.json({ name: parsed.name, version: parsed.version, sha256: hash, overridden: true });
    }
    db.insert(specs)
      .values({
        name: parsed.name,
        version: parsed.version,
        sha256: hash,
        content: text,
        createdAt: now,
      })
      .run();
    logger.info("spec uploaded", { req_id: reqId, name: parsed.name, version: parsed.version });
    return c.json({ name: parsed.name, version: parsed.version, sha256: hash }, 201);
  });

  app.get("/", (c) => {
    const namePattern = c.req.query("name");
    const versionPattern = c.req.query("version");
    const revisionPattern = c.req.query("release");

    const rows = db.select().from(specs).all();
    const filtered = rows.filter((row) => {
      if (namePattern && !globToRegExp(namePattern).test(row.name)) return false;
      if (versionPattern && !globToRegExp(versionPattern).test(row.version)) return false;
      if (revisionPattern) {
        const dash = row.version.lastIndexOf("-");
        const release = dash > 0 ? row.version.slice(dash + 1) : "";
        if (!globToRegExp(revisionPattern).test(release)) return false;
      }
      return true;
    });

    return c.json({
      specs: filtered.map((row) => ({
        name: row.name,
        version: row.version,
        sha256: row.sha256,
        createdAt: row.createdAt,
      })),
    });
  });

  return app;
}
