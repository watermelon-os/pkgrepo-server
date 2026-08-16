import { describe, it, expect } from "vitest";
import { makeApp, json } from "./helpers.js";

describe("authentication", () => {
  const tokens = [
    { value: "token-one", comment: "for tests", role: "admin" },
    { value: "token-two", comment: "runner", role: "runner" },
  ];

  // AUTH-01. Доступ без токена
  // - Дано: в конфиге объявлены токены
  // - Когда: запрос не содержит токен
  // - Тогда: ошибка
  it("отклоняет запрос без токена", async () => {
    const { app } = makeApp({ tokens } as never);
    const res = await json(app, "/api/packages");
    expect(res.status).toBe(401);
  });

  // AUTH-02. Неверный токен
  it("отклоняет запрос с неверным токеном", async () => {
    const { app } = makeApp({ tokens } as never);
    const res = await json(app, "/api/packages", { headers: { authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });

  // AUTH-03. Корректный токен
  it("обрабатывает запрос с валидным токеном", async () => {
    const { app } = makeApp({ tokens } as never);
    const res = await json(app, "/api/packages", {
      headers: { authorization: "Bearer token-one" },
    });
    expect(res.status).toBe(200);
  });

  it("принимает любой токен из конфига", async () => {
    const { app } = makeApp({ tokens } as never);
    const res = await json(app, "/api/packages", {
      headers: { authorization: "Bearer token-two" },
    });
    expect(res.status).toBe(200);
  });

  // AUTH-04. Колбэк с токеном
  it("отклоняет колбэк без токена", async () => {
    const { app } = makeApp({ commonTestUrl: "http://node/test", tokens } as never);
    await json(app, "/api/packages", {
      method: "POST",
      headers: { authorization: "Bearer token-one" },
      body: { name: "nginx", version: "1.0.0" },
    });
    const start = await json(app, "/api/packages/nginx/versions/1.0.0/test", {
      method: "POST",
      headers: { authorization: "Bearer token-one" },
      body: { testUrl: "http://node/test" },
    });
    expect(start.status).toBe(202);
    const { id } = (await start.json()) as { id: string };

    const cb = await json(app, `/api/packages/nginx/versions/1.0.0/test/${id}/callback`, {
      method: "POST",
      body: { result: "ok" },
    });
    expect(cb.status).toBe(401);
  });

  it("принимает колбэк с токеном", async () => {
    const { app } = makeApp({ commonTestUrl: "http://node/test", tokens } as never);
    await json(app, "/api/packages", {
      method: "POST",
      headers: { authorization: "Bearer token-one" },
      body: { name: "nginx", version: "1.0.0" },
    });
    const start = await json(app, "/api/packages/nginx/versions/1.0.0/test", {
      method: "POST",
      headers: { authorization: "Bearer token-one" },
      body: { testUrl: "http://node/test" },
    });
    const { id } = (await start.json()) as { id: string };

    const cb = await json(app, `/api/packages/nginx/versions/1.0.0/test/${id}/callback`, {
      method: "POST",
      headers: { authorization: "Bearer token-one" },
      body: { result: "ok" },
    });
    expect(cb.status).toBe(200);
  });
});
