import { sql } from "drizzle-orm";
import { z } from "zod";
import { Hono } from "hono";
import type { DatabaseClient } from "../db/index.js";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative().int(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const healthDbResponseSchema = z.object({
  status: z.literal("ok"),
  database: z.literal("ok"),
});
export type HealthDbResponse = z.infer<typeof healthDbResponseSchema>;

export interface HealthDeps {
  db: DatabaseClient;
  version: string;
  startedAt: number;
}

export function healthRoutes(deps: HealthDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const body: HealthResponse = {
      status: "ok",
      version: deps.version,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
    };
    return c.json(healthResponseSchema.parse(body));
  });

  app.get("/db", (c) => {
    deps.db.run(sql`SELECT 1`);
    const body: HealthDbResponse = { status: "ok", database: "ok" };
    return c.json(healthDbResponseSchema.parse(body));
  });

  return app;
}
