# watermelon-server-ts



## Stack

- **Hono** — HTTP server and routing (`@hono/node-server` Node adapter)
- **Zod** — runtime schemas, validation, and static typing of input/output
- **Drizzle ORM** — SQLite database access, `drizzle-kit` for migrations
- **better-sqlite3** — synchronous SQLite driver
- **Hono JSX (TSX)** — server-side rendering of simple informational pages
- **Vitest** — unit/integration tests
- **Commander** — a separate CLI that talks to the server over HTTP
- Standard `node:fs/promises` and `node:path` for filesystem access

## Requirements

- Node.js >= 20.12 (tested on Node 24, Linux)
- npm (or pnpm) — run all commands from this directory

## Setup

```sh
npm install
npm run db:generate   # generate SQL migration from src/db/schema.ts
npm run db:migrate    # apply migrations (creates data/watermelon.db)
```

Environment is read from `.env` when present (see `.env.example`):
`SERVER_HOST`, `SERVER_PORT`, `DATABASE_PATH`, `DEBUG`.

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

## CLI

```sh
npm run cli -- status          # GET /api/health
npm run cli -- version         # print package version
```

After `npm run build`, the CLI is also available as `wmserver-ts`.

## Layout

```
src/
  index.ts         server entry point
  app.ts           Hono app assembly
  config.ts        env config (Zod)
  version.ts       reads package.json via node:fs/promises
  cli.ts           Commander CLI (HTTP client)
  api/             REST endpoints with Zod schemas
  web/pages.tsx    SSR HTML pages (Hono JSX)
  db/              drizzle client, schema, migration runner
drizzle/           generated SQL migrations
tests/             vitest suite (in-memory SQLite)
```
