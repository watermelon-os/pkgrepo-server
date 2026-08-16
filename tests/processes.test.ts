import { describe, it, expect } from "vitest";
import { makeApp, json } from "./helpers.js";

describe("process orchestrators", () => {
  // ORCH-01. Нет процессов у пакета
  // - Дано: у пакета не настроено ни одного процесса
  // - Когда: вызывается тестирование или сборка
  // - Тогда: ошибка — процесс для пакета не настроен
  it("отклоняет тестирование без настроенных процессов", async () => {
    const { app } = makeApp({ fsRoot: "/tmp" });
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

  it("отклоняет сборку без настроенных процессов", async () => {
    const { app } = makeApp({ fsRoot: "/tmp" });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0/build", {
      method: "POST",
      body: { version: "1.0.0" },
    });
    expect(res.status).toBe(400);
  });

  // ORCH-02. Параллельные запуски
  // - Когда: запускаются несколько процессов одного пакета
  // - Тогда: запуски могут выполняться параллельно
  it("допускает параллельные запуски одного пакета", async () => {
    const started: string[] = [];
    const { app } = makeApp({
      commonBuildUrl: "http://node/build",
      orch: {
        start: (url: string) => {
          started.push(url);
          return { ok: true };
        },
      },
    });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });

    const [a, b] = await Promise.all([
      json(app, "/api/packages/nginx/versions/1.0.0/build", {
        method: "POST",
        body: { version: "1.0.0" },
      }),
      json(app, "/api/packages/nginx/versions/1.0.0/build", {
        method: "POST",
        body: { version: "1.0.0" },
      }),
    ]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(started.length).toBe(2);
  });
});