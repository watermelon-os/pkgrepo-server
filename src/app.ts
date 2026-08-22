import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { healthRoutes } from "./api/health.js";
import { namesRoutes, specsSearchRoutes } from "./api/names.js";
import { packageRoutes } from "./api/packages.js";
import { repoRoutes } from "./api/repos.js";
import type { DatabaseClient } from "./db/index.js";
import { createLogger, type Logger } from "./logger.js";
import type { RepoAdapter } from "./repoAdapter.js";
import type { Token } from "./types.js";

declare module "hono" {
  interface ContextVariableMap {
    reqId: string;
    logger: Logger;
  }
}

export interface AppDeps {
  db: DatabaseClient;
  version: string;
  startedAt?: number;
  logger?: Logger;
  fsRoot?: string;
  /** Логировать сканы синхронизации с нулем найденных пакетов (SYNC_LOG_EMPTY). */
  logEmptySync?: boolean;
  tokens?: Token[];
  repoAdapter?: RepoAdapter;
}

export function generateRequestId(): string {
  return randomBytes(6).toString("base64url");
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const logger = deps.logger ?? createLogger({ level: "info", name: "watermelon-server-ts" });

  app.use("*", async (c, next) => {
    if (deps.tokens && deps.tokens.length > 0) {
      // AUTH-01..03: доступ по токенам из конфига.
      const header = c.req.header("authorization");
      const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
      if (!bearer || !deps.tokens.some((t) => t.value === bearer)) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }
    const reqId = generateRequestId();
    const reqLogger = logger.child({ req_id: reqId });
    c.set("reqId", reqId);
    c.set("logger", reqLogger);
    const startedAt = Date.now();
    reqLogger.debug("request started", { method: c.req.method, path: c.req.path });
    await next();
    reqLogger.info("request done", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - startedAt,
    });
  });

  app.route("/api/health", healthRoutes({ ...deps, startedAt: deps.startedAt ?? Date.now() }));
  app.route("/api/packages", packageRoutes(deps));
  app.route("/api/repos", repoRoutes(deps));
  app.route("/api/names", namesRoutes(deps));
  app.route("/api/specs", specsSearchRoutes(deps));

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    const reqLogger = c.get("logger");
    reqLogger.error("unhandled error", { message: err instanceof Error ? err.message : String(err) });
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}