import { describe, it, expect } from "vitest";
import { makeApp, json } from "./helpers.js";

describe("building a package", () => {
  // BLD-01. Сборка фантома через any
  // - Дано: пакет-фантом без версии
  // - Когда: запрашивается сборка
  // - Тогда: сборка возможна с версией `any`
  it("разрешает сборку фантома с версией any", async () => {
    const { app } = makeApp({ commonBuildUrl: "http://node/build" });
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    const res = await json(app, "/api/packages/nginx/build", {
      method: "POST",
      body: { version: "any" },
    });
    expect(res.status).toBe(202);
  });

  // BLD-02. Раннер обязан дать версию
  it("ошибка, если раннер вернул версию any", async () => {
    const { app } = makeApp({ commonBuildUrl: "http://node/build" });
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    const start = await json(app, "/api/packages/nginx/build", {
      method: "POST",
      body: { version: "any" },
    });
    const { id } = (await start.json()) as { id: string };
    const res = await json(app, `/api/packages/nginx/build/${id}/callback`, {
      method: "POST",
      body: { result: "ok", version: "any" },
    });
    expect(res.status).toBe(400);
  });

  // BLD-03. Статус сборки по последней валидной
  it("считает статус сборки по последней завершенной валидной записи", async () => {
    const { app } = makeApp({ commonBuildUrl: "http://node/build" });
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    const start = await json(app, "/api/packages/nginx/build", {
      method: "POST",
      body: { version: "any" },
    });
    const { id } = (await start.json()) as { id: string };
    const res = await json(app, `/api/packages/nginx/build/${id}/callback`, {
      method: "POST",
      body: { result: "ok", version: "1.0.0" },
    });
    expect(res.status).toBe(200);

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ versions: Array<{ buildStatus?: string }> }>;
    };
    expect(body.packages[0].versions[0].buildStatus).toBe("ok");
  });

  // BLD-04. Недействительность сборки
  it("игнорирует недействительную запись сборки", async () => {
    const { app } = makeApp({ commonBuildUrl: "http://node/build" });
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    const start = await json(app, "/api/packages/nginx/build", {
      method: "POST",
      body: { version: "any" },
    });
    const { id } = (await start.json()) as { id: string };
    await json(app, `/api/packages/nginx/build/${id}/callback`, {
      method: "POST",
      body: { result: "ok", version: "1.0.0" },
    });
    const inv = await json(app, `/api/packages/nginx/build/${id}/invalidate`, {
      method: "POST",
      body: {},
    });
    expect(inv.status).toBe(200);

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ versions: Array<{ buildStatus?: string | null }> }>;
    };
    expect(body.packages[0].versions[0].buildStatus).not.toBe("ok");
  });

  // BLD-05. Отдельные сущности сборки
  it("хранит журнал и url сборки отдельно от тестирования", async () => {
    const { app } = makeApp({
      commonTestUrl: "http://node/test",
      commonBuildUrl: "http://node/build",
    });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const testLog = await json(app, "/api/packages/nginx/versions/1.0.0/test/log");
    expect(testLog.status).toBe(200);
    const buildLog = await json(app, "/api/packages/nginx/versions/1.0.0/build/log");
    expect(buildLog.status).toBe(200);
  });
});