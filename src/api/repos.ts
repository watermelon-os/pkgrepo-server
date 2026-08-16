import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { Hono } from "hono";
import type { DatabaseClient } from "../db/index.js";
import { packages, repositories } from "../db/schema.js";
import { createLogger, type Logger } from "../logger.js";
import { isRepoInitialized } from "../repoAdapter.js";

export interface ReposApiDeps {
  db: DatabaseClient;
  logger?: Logger;
}

const createdBodySchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._+~-]+$/),
  path: z.string().min(1),
  type: z.enum(["rpm", "deb"]),
});

export function repoRoutes(deps: ReposApiDeps): Hono {
  const db = deps.db;
  const logger = deps.logger ?? createLogger({ level: "info" });

  const app = new Hono();

  // REP-05. Список репозиториев.
  app.get("/", (c) => {
    const all = db.select().from(repositories).all();
    return c.json({ repositories: all });
  });

  // REP-01..04. Создание репозитория.
  app.post("/", async (c) => {
    const reqId = c.get("reqId");
    let body: z.infer<typeof createdBodySchema>;
    try {
      body = createdBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (!existsSync(body.path)) {
      // REP-02: путь не существует — ошибка.
      return c.json({ error: "repository_path_not_found" }, 400);
    }
    if (!isRepoInitialized(body.path, body.type)) {
      // REP-03: не проинициализирована — нет маркеров типа.
      return c.json({ error: "repository_not_initialized" }, 400);
    }
    const existing = db.select().from(repositories).where(eq(repositories.name, body.name)).get();
    if (existing) {
      // REP-04: дубликат имени — ошибка.
      return c.json({ error: "repository_exists" }, 409);
    }
    db.insert(repositories)
      .values({
        name: body.name,
        path: body.path,
        type: body.type,
        createdAt: new Date(),
      })
      .run();
    logger.info("repository created", { req_id: reqId, name: body.name, path: body.path });
    const created = db.select().from(repositories).where(eq(repositories.name, body.name)).get();
    return c.json(created!, 201);
  });

  // REP-06. Получение репозитория.
  app.get("/:name", (c) => {
    const name = c.req.param("name");
    const row = db.select().from(repositories).where(eq(repositories.name, name)).get();
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(row);
  });

  // REP-07. Удаление репозитория.
  app.delete("/:name", (c) => {
    const reqId = c.get("reqId");
    const name = c.req.param("name");
    const row = db.select().from(repositories).where(eq(repositories.name, name)).get();
    if (!row) {
      logger.warn("repository delete for unknown name", { req_id: reqId, name });
      return c.json({ error: "not_found" }, 404);
    }
    db.delete(repositories).where(eq(repositories.name, name)).run();
    // REP-07: убираем репозиторий из свойств всех пакетов.
    for (const pkg of db.select().from(packages).all()) {
      if (pkg.repositories.includes(name)) {
        db.update(packages)
          .set({ repositories: pkg.repositories.filter((r) => r !== name) })
          .where(eq(packages.name, pkg.name))
          .run();
      }
    }
    logger.info("repository deleted", { req_id: reqId, name });
    return c.body(null, 204);
  });

  return app;
}