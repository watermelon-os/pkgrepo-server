import { Hono } from "hono";
import { healthRoutes } from "./api/health.js";
import { metaRoutes } from "./api/meta.js";
import type { DatabaseClient } from "./db/index.js";

export interface AppDeps {
  db: DatabaseClient;
  version: string;
  startedAt?: number;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.route("/api/health", healthRoutes({ ...deps, startedAt: deps.startedAt ?? Date.now() }));
  app.route("/api/meta", metaRoutes(deps.db));

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error("[watermelon-server-ts] unhandled error:", err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
