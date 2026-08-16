import { describe, it, expect } from "vitest";
import { makeApp, json, memoryLogger } from "./helpers.js";

describe("server", () => {
  // SVR-01. Запрос при недоступной БД
  // - Когда: поступает запрос, требующий обращения к БД, а БД недоступна
  // - Тогда: возвращается ошибка
  it("возвращает ошибку при недоступной БД", async () => {
    const db = {
      prepare: (): never => {
        throw new Error("db is down");
      },
    } as never;
    const { app } = makeApp({ db });
    const res = await json(app, "/api/packages");
    expect(res.status).toBe(500);
  });

  // SVR-02. id запроса
  // - Когда: сервер принимает запрос (команду)
  // - Тогда: запрос получает короткий уникальный id
  // - Тогда: логи содержат id запроса
  it("логирует запрос с id", async () => {
    const { logger, lines } = memoryLogger("debug");
    const { app } = makeApp({ logger });
    await json(app, "/api/packages");
    const hasRequestId = lines.some((line) => /req_id|request_id/.test(line));
    expect(hasRequestId).toBe(true);
  });
});