import { describe, it, expect } from "vitest";
import { makeApp, json } from "./helpers.js";

describe("testing a package", () => {
  // TST-01. Фантом нельзя тестировать
  // - Дано: пакет-фантом без версии
  // - Когда: запрашивается тестирование
  // - Тогда: ошибка — журнал тестирования привязан к версии
  it("отклоняет тестирование фантома", async () => {
    const { app } = makeApp({ commonTestUrl: "http://node/test" });
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    const res = await json(app, "/api/packages/nginx/test", { method: "POST", body: {} });
    expect(res.status).toBe(400);
  });

  // TST-02. Запись о начале тестирования
  it("записывает о начале тестирования", async () => {
    const { app } = makeApp({ commonTestUrl: "http://node/test" });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0/test", {
      method: "POST",
      body: { testUrl: "http://node/test" },
    });
    expect(res.status).toBe(202);

    const journal = await json(app, "/api/packages/nginx/versions/1.0.0/test/log");
    expect(journal.status).toBe(200);
    const body = (await journal.json()) as { entries: Array<{ id: string; status: string }> };
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.entries[0]!.status).toBe("running");
  });

  // TST-03. Статус по последней валидной записи
  it("считает статус по последней завершенной валидной записи", async () => {
    const { app } = makeApp({ commonTestUrl: "http://node/test" });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const start = await json(app, "/api/packages/nginx/versions/1.0.0/test", {
      method: "POST",
      body: { testUrl: "http://node/test" },
    });
    const { id } = (await start.json()) as { id: string };

    const cb = await json(app, `/api/packages/nginx/versions/1.0.0/test/${id}/callback`, {
      method: "POST",
      body: { result: "ok" },
    });
    expect(cb.status).toBe(200);

    const res = await json(app, "/api/packages?name=nginx");
    const body = (await res.json()) as {
      packages: Array<{
        versions: Array<{ testStatus?: string }>;
      }>;
    };
    expect(body.packages[0]!.versions[0]!.testStatus).toBe("ok");
  });

  // TST-04. Недействительная запись игнорируется
  it("игнорирует недействительную запись при вычислении статуса", async () => {
    const { app } = makeApp({ commonTestUrl: "http://node/test" });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const start = await json(app, "/api/packages/nginx/versions/1.0.0/test", {
      method: "POST",
      body: { testUrl: "http://node/test" },
    });
    const { id } = (await start.json()) as { id: string };
    await json(app, `/api/packages/nginx/versions/1.0.0/test/${id}/callback`, {
      method: "POST",
      body: { result: "ok" },
    });
    const inv = await json(app, `/api/packages/nginx/versions/1.0.0/test/${id}/invalidate`, {
      method: "POST",
      body: {},
    });
    expect(inv.status).toBe(200);

    const res = await json(app, "/api/packages?name=nginx");
    const body = (await res.json()) as {
      packages: Array<{ versions: Array<{ testStatus?: string | null }> }>;
    };
    expect(body.packages[0]!.versions[0]!.testStatus).not.toBe("ok");
  });

  // TST-05. Сбой запуска процесса
  it("записывает ошибку при сбое запуска процесса", async () => {
    const { app } = makeApp({
      commonTestUrl: "http://node/test",
      orch: { start: () => ({ ok: false, error: "process could not start" }) },
    });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0/test", {
      method: "POST",
      body: { testUrl: "http://node/test" },
    });
    expect(res.status).toBe(502);

    const journal = await json(app, "/api/packages/nginx/versions/1.0.0/test/log");
    const body = (await journal.json()) as { entries: Array<{ status: string }> };
    expect(body.entries[0]!.status).toBe("error");
  });

  // TST-06. url теста не задан
  it("использует общий url теста при отсутствии url пакета", async () => {
    const { app } = makeApp({ commonTestUrl: "http://node/test" });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0/test", {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(202);
  });

  it("ошибка, если ни у пакета, ни общий url теста не задан", async () => {
    const { app } = makeApp();
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0/test", {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(400);
  });

  // TST-07. Ответ запуска сохраняется в журнал; id через шаблонизатор url
  it("подставляет id в шаблонизированный url запуска и сохраняет ответ запуска в журнал", async () => {
    const started: string[] = [];
    const { app } = makeApp({
      commonTestUrl: "http://node/test/{id}",
      orch: {
        start: (url: string) => {
          started.push(url);
          return { ok: true, response: "http://proc/1234" };
        },
      },
    });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0/test", {
      method: "POST",
      body: { testUrl: "http://node/test/{id}" },
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };

    // id подставлен в url запуска
    expect(started[0]).toBe(`http://node/test/${id}`);

    const journal = await json(app, "/api/packages/nginx/versions/1.0.0/test/log");
    const body = (await journal.json()) as {
      entries: Array<{ id: string; status: string; body?: string }>;
    };
    expect(body.entries[0]!.body).toBe("http://proc/1234");
  });

  // CBK-01. Результат из переменных url колбэка; body как есть
  it("принимает результат через переменную url колбэка и сохраняет body как есть", async () => {
    const { app } = makeApp({ commonTestUrl: "http://node/test" });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const start = await json(app, "/api/packages/nginx/versions/1.0.0/test", {
      method: "POST",
      body: { testUrl: "http://node/test" },
    });
    const { id } = (await start.json()) as { id: string };

    // результат в переменной url шаблона, body — plain text
    const cb = await app.request(
      `/api/packages/nginx/versions/1.0.0/test/${id}/callback?result=ok`,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "see https://example.com/report",
      },
    );
    expect(cb.status).toBe(200);

    const journal = await json(app, "/api/packages/nginx/versions/1.0.0/test/log");
    const body = (await journal.json()) as {
      entries: Array<{ id: string; status: string; body?: string }>;
    };
    expect(body.entries[0]!.status).toBe("ok");
    expect(body.entries[0]!.body).toBe("see https://example.com/report");
  });
});