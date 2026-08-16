import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { openDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { readVersion } from "./version.js";

async function main(): Promise<void> {
  loadDotEnv(".env");
  const config = loadConfig();

  await runMigrations(config.DATABASE_PATH);
  const { db, sqlite } = await openDb(config.DATABASE_PATH);

  const version = await readVersion();
  const app = createApp({ db, version });

  serve(
    { fetch: app.fetch, hostname: config.SERVER_HOST, port: config.SERVER_PORT },
    (info) => {
      console.log(
        `[watermelon-server-ts] v${version} listening on http://${config.SERVER_HOST}:${info.port}`,
      );
    },
  );

  const shutdown = (): void => {
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
