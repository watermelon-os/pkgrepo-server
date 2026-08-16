import { serve } from "@hono/node-server";
import { createApp, generateRequestId } from "./app.js";
import { runSync } from "./api/packages.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { openDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { createLogger } from "./logger.js";
import { createRepoAdapter } from "./repoAdapter.js";
import { readVersion } from "./version.js";

async function main(): Promise<void> {
  loadDotEnv(".env");
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, name: "watermelon-server-ts" });

  await runMigrations(config.DATABASE_PATH, undefined, logger);
  const { db, sqlite } = await openDb(config.DATABASE_PATH);

  const version = await readVersion();
  const repoAdapter = createRepoAdapter({ useUtilities: config.USE_PACKAGE_UTILITIES, logger });
  const app = createApp({ db, version, logger, repoAdapter });

  serve(
    { fetch: app.fetch, hostname: config.SERVER_HOST, port: config.SERVER_PORT },
    (info) => {
      logger.info("listening", {
        version,
        url: `http://${config.SERVER_HOST}:${info.port}`,
      });
    },
  );

  // Фоновая синхронизация с фс (SVR-03): периодический скан репозиториев.
  let syncing = false;
  const syncDeps = { db, logger, repoAdapter };
  const syncRun = async (): Promise<void> => {
    if (syncing) {
      logger.warn("sync: skipped, previous run still in progress");
      return;
    }
    syncing = true;
    try {
      await runSync(syncDeps, generateRequestId());
    } catch (error) {
      logger.error("sync: run failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      syncing = false;
    }
  };
  const syncTimer: ReturnType<typeof setInterval> | undefined =
    config.SYNC_INTERVAL_SECONDS > 0
      ? setInterval(() => {
          void syncRun();
        }, config.SYNC_INTERVAL_SECONDS * 1000)
      : undefined;

  const shutdown = (): void => {
    logger.info("shutting down");
    if (syncTimer !== undefined) clearInterval(syncTimer);
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
