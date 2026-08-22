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
});
