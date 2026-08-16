import { eq } from "drizzle-orm";
import { z } from "zod";
import { Hono } from "hono";
import { appMeta } from "../db/schema.js";
import type { DatabaseClient } from "../db/index.js";

export const metaKeySchema = z.object({
  key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/),
});
export type MetaKey = z.infer<typeof metaKeySchema>;

export const metaValueSchema = z.object({
  value: z.string().min(1).max(4096),
});
export type MetaValue = z.infer<typeof metaValueSchema>;

export const metaResponseSchema = z.object({
  key: z.string(),
  value: z.string(),
});
export type MetaResponse = z.infer<typeof metaResponseSchema>;

export function metaRoutes(db: DatabaseClient): Hono {
  const app = new Hono();

  app.get("/:key", (c) => {
    const key = metaKeySchema.safeParse(c.req.param());
    if (!key.success) {
      return c.json({ error: "invalid_request", issues: key.error.flatten() }, 400);
    }
    const row = db.select().from(appMeta).where(eq(appMeta.key, key.data.key)).get();
    if (!row) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(metaResponseSchema.parse(row));
  });

  app.put("/:key", async (c) => {
    const key = metaKeySchema.safeParse(c.req.param());
    if (!key.success) {
      return c.json({ error: "invalid_request", issues: key.error.flatten() }, 400);
    }
    let body: MetaValue;
    try {
      body = metaValueSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    db.insert(appMeta)
      .values({ key: key.data.key, value: body.value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: body.value } })
      .run();
    const parsed = metaResponseSchema.parse({ key: key.data.key, value: body.value });
    return c.json(parsed, 201);
  });

  return app;
}
