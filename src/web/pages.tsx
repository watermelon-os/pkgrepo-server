import { Hono } from "hono";
import type { Child, FC } from "hono/jsx";

interface LayoutProps {
  title: string;
  children?: Child;
}

const Layout: FC<LayoutProps> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{title}</title>
      <style>{`body { font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }`}</style>
    </head>
    <body>{children}</body>
  </html>
);

interface HomePageProps {
  version: string;
}

export const HomePage: FC<HomePageProps> = ({ version }) => (
  <Layout title="Watermelon Server (TypeScript)">
    <h1>Watermelon Server (TypeScript)</h1>
    <p>Clean skeleton: Hono + Zod + Drizzle ORM + SQLite, SSR via Hono JSX.</p>
    <p>
      Version <code>{version}</code>. API health:{" "}
      <a href="/api/health">/api/health</a>, database check:{" "}
      <a href="/api/health/db">/api/health/db</a>.
    </p>
  </Layout>
);

export interface WebDeps {
  version: string;
}

export function webRoutes(deps: WebDeps): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(<HomePage version={deps.version} />));
  return app;
}
