import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import type { OrchClient, Token } from "../../types.js";
import { buildJournal, testJournal } from "../../db/schema.js";
import type { PackageApiDeps } from "./deps.js";
import { runBodySchema } from "./schemas.js";
import { getPackage } from "./artifacts.js";

/** Шаблонизатор url: подставляет `{id}` в url запуска процесса. */
export function templatizeUrl(url: string, values: Record<string, string>): string {
  let result = url;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

/** Токен раннера: роль `runner` при наличии, иначе первый из объявленных. */
export function runnerToken(tokenList: readonly Token[] | undefined): string {
  if (!tokenList || tokenList.length === 0) return "";
  return tokenList.find((t) => t.role === "runner")?.value ?? tokenList[0]!.value;
}

export async function startTest(
  c: Context,
  deps: PackageApiDeps,
  orch: OrchClient,
  name: string,
  version: string,
) {
  const db = deps.db;
  let body: z.infer<typeof runBodySchema>;
  try {
    body = runBodySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  const pkg = getPackage(db, name);
  if (!pkg) return c.json({ error: "not_found" }, 404);
  const testUrl = body.testUrl ?? pkg.testUrl ?? deps.commonTestUrl;
  // TST-06/ORCH-01: url теста не задан — ошибка.
  if (!testUrl) return c.json({ error: "no_test_url" }, 400);

  const reqId = c.get("reqId");
  const now = new Date();
  db.insert(testJournal)
    .values({
      id: reqId,
      packageName: name,
      version,
      status: "running",
      invalid: false,
      body: null,
      createdAt: now,
    })
    .run();

  // AUTH: url колбэка содержит id и токен раннера.
  const token = runnerToken(deps.tokens);
  const callbackUrl = `/api/packages/${name}/versions/${version}/test/${reqId}/callback?token=${encodeURIComponent(token)}`;
  const launchUrl = templatizeUrl(testUrl, { id: reqId, token, callbackUrl });
  const result = await orch.start(launchUrl);
  if (!result.ok) {
    // TST-05: сбой запуска процесса — запись в журнал как ошибка.
    db.update(testJournal)
      .set({ status: "error" })
      .where(eq(testJournal.id, reqId))
      .run();
    return c.json({ error: "process_start_failed" }, 502);
  }
  // TST-07: ответ на вызов url запуска сохраняется в запись журнала.
  if (result.response !== undefined) {
    db.update(testJournal)
      .set({ body: result.response })
      .where(eq(testJournal.id, reqId))
      .run();
  }
  return c.json({ id: reqId }, 202);
}

export async function startBuild(
  c: Context,
  deps: PackageApiDeps,
  orch: OrchClient,
  name: string,
  version: string,
) {
  const db = deps.db;
  const pkg = getPackage(db, name);
  if (!pkg) return c.json({ error: "not_found" }, 404);
  const buildUrl = pkg.buildUrl ?? deps.commonBuildUrl;
  // ORCH-01: нет настроенных процессов — ошибка.
  if (!buildUrl) return c.json({ error: "no_build_url" }, 400);

  const reqId = c.get("reqId");
  const now = new Date();
  db.insert(buildJournal)
    .values({
      id: reqId,
      packageName: name,
      version,
      resultVersion: null,
      status: "running",
      invalid: false,
      body: null,
      createdAt: now,
    })
    .run();

  // AUTH: url колбэка содержит id и токен раннера.
  const token = runnerToken(deps.tokens);
  const callbackUrl = `/api/packages/${name}/build/${reqId}/callback?token=${encodeURIComponent(token)}`;
  const launchUrl = templatizeUrl(buildUrl, { id: reqId, token, callbackUrl });
  const result = await orch.start(launchUrl);
  if (!result.ok) {
    db.update(buildJournal)
      .set({ status: "error" })
      .where(eq(buildJournal.id, reqId))
      .run();
    return c.json({ error: "process_start_failed" }, 502);
  }
  if (result.response !== undefined) {
    db.update(buildJournal)
      .set({ body: result.response })
      .where(eq(buildJournal.id, reqId))
      .run();
  }
  return c.json({ id: reqId }, 202);
}