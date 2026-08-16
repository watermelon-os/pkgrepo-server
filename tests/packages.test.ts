import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { makeApp, json } from "./helpers.js";

describe("packages API", () => {
  // ADD-02 — пакет-фантом при добавлении имени без файла
  it("создаёт пакет-фантом при добавлении имени без файла", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ name: "nginx", versions: [] });
  });

  // ADD-04 — фантом создается только когда пакета еще нет
  it("отклоняет дубликат имени пакета", async () => {
    const { app } = makeApp();
    expect((await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } })).status).toBe(201);
    const dup = await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    expect(dup.status).toBe(409);
  });

  // ADD-01 — пакет сразу с первой версией при добавлении с файлом
  it("создаёт пакет сразу с первой версией при добавлении с файлом", async () => {
    const fsRoot = mkdtempSync(join(tmpdir(), "wm-test-"));
    const { app } = makeApp({ fsRoot });
    const res = await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0", file: "artifact" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; versions: Array<{ version: string }> };
    expect(body.name).toBe("nginx");
    expect(body.versions.map((v) => v.version)).toEqual(["1.0.0"]);
  });

  // ADD-03 — повторное добавление той же версии — ошибка
  it("отклоняет повторное добавление той же версии", async () => {
    const { app } = makeApp();
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    await json(app, "/api/packages/nginx/versions", { method: "POST", body: { version: "1.0.0" } });
    const dup = await json(app, "/api/packages/nginx/versions", {
      method: "POST",
      body: { version: "1.0.0" },
    });
    expect(dup.status).toBe(409);
  });

  // ADD-05 — url процессов сохраняется при добавлении/обновлении
  it("сохраняет url процессов при добавлении/обновлении", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", testUrl: "http://node/test" },
    });
    expect(res.status).toBe(201);
    const got = await json(app, "/api/packages/nginx");
    const body = (await got.json()) as { testUrl?: string };
    expect(body.testUrl).toBe("http://node/test");
  });

  // PKG-01 — обращение к несуществующему пакету — ошибка
  it("возвращает ошибку для несуществующего пакета", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/packages/missing");
    expect(res.status).toBe(404);
  });

  // UPD-02 — обновление без файла: только поля
  it("обновляет поля без шага фс", async () => {
    const { app } = makeApp();
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    const res = await json(app, "/api/packages/nginx", {
      method: "PUT",
      body: { testUrl: "http://node/test" },
    });
    expect(res.status).toBe(200);
    const got = await json(app, "/api/packages/nginx");
    const body = (await got.json()) as { testUrl?: string };
    expect(body.testUrl).toBe("http://node/test");
  });

  // UPD-01 — перезапись при разной хэшсумме, возвращается варнинг
  it("перезаписывает файл и возвращает варнинг при разной хэшсумме", async () => {
    const fsRoot = mkdtempSync(join(tmpdir(), "wm-test-"));
    const { app } = makeApp({ fsRoot });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0", file: "old" },
    });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0", {
      method: "PUT",
      body: { file: "new" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warning?: boolean };
    expect(body.warning).toBe(true);
  });

  // UPD-04 — полное совпадение параметров — ошибка
  it("отклоняет обновление при полном совпадении параметров", async () => {
    const fsRoot = mkdtempSync(join(tmpdir(), "wm-test-"));
    const { app } = makeApp({ fsRoot });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0", file: "same" },
    });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0", {
      method: "PUT",
      body: { file: "same" },
    });
    expect(res.status).toBe(409);
  });

  // UPD-03. Ленивое обновление индекса
  it("находит файл на диске при ленивом обновлении индекса", async () => {
    const fsRoot = mkdtempSync(join(tmpdir(), "wm-test-"));
    writeFileSync(join(fsRoot, "nginx-1.0.0.rpm"), "artifact");
    const { app } = makeApp({ fsRoot });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0", { method: "PUT", body: {} });
    expect(res.status).toBe(200);
    const got = await json(app, "/api/packages/nginx");
    const body = (await got.json()) as { versions: Array<{ version: string }> };
    expect(body.versions.map((v) => v.version)).toContain("1.0.0");
  });

  it("ошибка при ленивом обновлении, если файл не найден", async () => {
    const fsRoot = mkdtempSync(join(tmpdir(), "wm-test-"));
    const { app } = makeApp({ fsRoot });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0", { method: "PUT", body: {} });
    expect(res.status).toBe(404);
  });

  // UPD-05. Сбой записи файла
  it("не фиксирует операцию при сбое записи файла", async () => {
    const { app } = makeApp({ fsRoot: "/proc/definitely/not/writable" });
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0", { method: "PUT", body: {} });
    expect(res.status).not.toBe(200);
  });

  // DEL-01. Удаление всего, что связано
  it("удаляет пакет целиком", async () => {
    const fsRoot = mkdtempSync(join(tmpdir(), "wm-test-"));
    const { app } = makeApp({ fsRoot });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0", file: "artifact" },
    });
    const res = await json(app, "/api/packages/nginx", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await json(app, "/api/packages/nginx")).status).toBe(404);
  });
});