# pkgrepo-server



## Stack

- **Hono** — HTTP server and routing (`@hono/node-server` Node adapter)
- **Zod** — runtime schemas, validation, and static typing of input/output
- **Drizzle ORM** — SQLite database access, `drizzle-kit` for migrations
- **better-sqlite3** — synchronous SQLite driver
- **Vitest** — unit/integration tests
- Standard `node:fs/promises` and `node:path` for filesystem access

## Requirements

- Node.js >= 20.12 (tested on Node 24, Linux)
- npm (or pnpm) — run all commands from this directory

## Setup

```sh
npm install
npm run db:generate   # generate SQL migration from src/db/schema.ts
npm run db:migrate    # apply migrations (creates data/pkgrepo-server.db)
```

Environment is read from `.env` when present (see `.env.example`):
`SERVER_HOST`, `SERVER_PORT`, `DATABASE_PATH`, `LOG_LEVEL`, `LOG_STANDARD_FIELDS`, `REPO_ROOT`, `USE_PACKAGE_UTILITIES`, `SYNC_INTERVAL_SECONDS`, `TOKENS`.

`LOG_STANDARD_FIELDS` (optional, default empty) lists which standard log fields print their key prefix (`time`, `level`, `logger`, `msg`). By default keys are hidden but values still print, e.g. `2026-08-16T... INFO pkgrepo-server hello foo=bar`.

`REPO_ROOT` (optional) is a prepared root directory for repositories, must exist if set. When set, `POST /api/repos` resolves paths relative to it (absolute paths must stay inside it), creates missing directories and initializes missing format markers automatically. When unset, repository paths must already exist and be initialized.

`TOKENS` (optional) enables authentication: a JSON array of token objects `[{"value": "...", "comment": "...", "role": "..."}]`. When empty/unset, authentication is off. Tokens are validated on startup (CFG-01) and are never printed to the log. Callback URLs handed to runners contain the runner token (the one with role `runner`, otherwise the first one); launch URL templates can use `{id}`, `{token}` and `{callbackUrl}` placeholders.

## Development

```sh
npm run dev           # run with tsx watch
npm test              # vitest run
npm run typecheck     # tsc --noEmit
```

## Build & run

```sh
npm run build         # tsc -> dist/
npm start             # node dist/index.js
```

## Layout

```
src/
  index.ts         server entry point (migrations, sync timer)
  app.ts           Hono app assembly
  config.ts        env config (Zod)
  logger.ts        structured logging
  version.ts       reads package.json via node:fs/promises
  artifacts.ts     artifact filename templates + name parser
  repoAdapter.ts   package-tool inspectors and repo DB generators
  api/             REST endpoints (health, repos, packages) with Zod schemas
  api/packages/    packages logic: schemas, artifacts, response, process, sync
  db/              drizzle client, schema, migration runner
drizzle/           generated SQL migrations
tests/             vitest suite (in-memory SQLite)
```
