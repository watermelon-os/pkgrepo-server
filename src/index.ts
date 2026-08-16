import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { openDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { createLogger } from "./logger.js";
import { readVersion } from "./version.js";

async function main(): Promise<void> {
  loadDotEnv(".env");
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, name: "watermelon-server-ts" });

  await runMigrations(config.DATABASE_PATH, undefined, logger);
  const { db, sqlite } = await openDb(config.DATABASE_PATH);

  const version = await readVersion();
  const app = createApp({ db, version, logger });

  serve(
    { fetch: app.fetch, hostname: config.SERVER_HOST, port: config.SERVER_PORT },
    (info) => {
      logger.info("listening", {
        version,
        url: `http://${config.SERVER_HOST}:${info.port}`,
      });
    },
  );

  const shutdown = (): void => {
    logger.info("shutting down");
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
