import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { healthRoutes } from "./api/health.js";
import { metaRoutes } from "./api/meta.js";
import { packageRoutes } from "./api/packages.js";
import type { DatabaseClient } from "./db/index.js";
import { createLogger, type Logger } from "./logger.js";

declare module "hono" {
  interface ContextVariableMap {
    reqId: string;
    logger: Logger;
  }
}

export interface OrchClient {
  start(url: string): Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
}

export interface AppDeps {
  db: DatabaseClient;
  version: string;
  startedAt?: number;
  logger?: Logger;
  fsRoot?: string;
  commonTestUrl?: string;
  commonBuildUrl?: string;
  orch?: OrchClient;
}

export function generateRequestId(): string {
  return randomBytes(6).toString("base64url");
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const logger = deps.logger ?? createLogger({ level: "info", name: "watermelon-server-ts" });

  app.use("*", async (c, next) => {
    const reqId = generateRequestId();
    const reqLogger = logger.child({ req_id: reqId });
    c.set("reqId", reqId);
    c.set("logger", reqLogger);
    reqLogger.info("request", { method: c.req.method, path: c.req.path });
    await next();
  });

  app.route("/api/health", healthRoutes({ ...deps, startedAt: deps.startedAt ?? Date.now() }));
  app.route("/api/meta", metaRoutes(deps.db));
  app.route("/api/packages", packageRoutes(deps));

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    const reqLogger = c.get("logger");
    reqLogger.error("unhandled error", { message: err instanceof Error ? err.message : String(err) });
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}