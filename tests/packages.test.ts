import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, it, expect } from "vitest";
import * as schema from "../src/db/schema.js";
import { packages, versions } from "../src/db/schema.js";
import { makeApp, json } from "./helpers.js";

function rpmRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wm-test-"));
  mkdirSync(join(dir, "repodata"), { recursive: true });
  return dir;
}

async function createRepo(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
  const path = rpmRepo();
  const res = await json(app, "/api/repos", {
    method: "POST",
    body: { name: "a", path, type: "rpm" },
  });
  expect(res.status).toBe(201);
  return path;
}

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
    const { app } = makeApp();
    await createRepo(app);
    const res = await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0-1.x86_64", repositories: ["a"], file: "artifact" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; versions: Array<{ version: string }> };
    expect(body.name).toBe("nginx");
    expect(body.versions.map((v) => v.version)).toEqual(["1.0.0-1.x86_64"]);
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
    const { app } = makeApp();
    await createRepo(app);
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0-1.x86_64", repositories: ["a"], file: "old" },
    });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64", {
      method: "PUT",
      body: { file: "new" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warning?: boolean };
    expect(body.warning).toBe(true);
  });

  // UPD-04 — полное совпадение параметров — ошибка
  it("отклоняет обновление при полном совпадении параметров", async () => {
    const { app } = makeApp();
    await createRepo(app);
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0-1.x86_64", repositories: ["a"], file: "same" },
    });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64", {
      method: "PUT",
      body: { file: "same" },
    });
    expect(res.status).toBe(409);
  });

  // UPD-03. Ленивое обновление индекса
  it("находит файл в репозитории при ленивом обновлении индекса", async () => {
    const { app } = makeApp();
    const path = await createRepo(app);
    writeFileSync(join(path, "nginx-1.0.0-1.x86_64.rpm"), "artifact");
    const res = await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64", { method: "PUT", body: {} });
    expect(res.status).toBe(200);
    const got = await json(app, "/api/packages/nginx");
    const body = (await got.json()) as { versions: Array<{ version: string }> };
    expect(body.versions.map((v) => v.version)).toContain("1.0.0-1.x86_64");
  });

  it("ошибка при ленивом обновлении, если файл не найден", async () => {
    const { app } = makeApp();
    await createRepo(app);
    const res = await json(app, "/api/packages/nginx/versions/1.0.0", { method: "PUT", body: {} });
    expect(res.status).toBe(404);
  });

  // UPD-05. Сбой записи файла
  it("не фиксирует операцию при сбое записи файла", async () => {
    const { app } = makeApp();
    await createRepo(app);
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0", {
      method: "PUT",
      body: { file: "new" },
    });
    expect(res.status).not.toBe(200);
  });

  // ATOM-01. Компенсация при сбое записи в бд
  // - Дано: шаг с фс удался (файл записан в репозиторий)
  // - Когда: запись в бд не проходит
  // - Тогда: записанное удаляется (компенсация), операция возвращает ошибку
  it("удаляет записанный файл при сбое записи в бд", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "wm-test-"));
    mkdirSync(join(repoPath, "repodata"), { recursive: true });
    const artifact = join(repoPath, "nginx-1.0.0-1.x86_64.rpm");

    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: resolve(import.meta.dirname, "../drizzle") });
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (table === versions) {
              return {
                values: () => ({
                  run: () => {
                    throw new Error("db down");
                  },
                }),
              } as never;
            }
            return Reflect.get(target, prop, receiver).call(target, table as never);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as never;

    const { app } = makeApp({ db: failingDb } as never);
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path: repoPath, type: "rpm" },
    });
    const res = await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0-1.x86_64", repositories: ["a"], file: "content" },
    });
    expect(res.status).toBe(500);
    expect(existsSync(artifact)).toBe(false);
  });

  // DEL-01. Удаление всего, что связано
  it("удаляет пакет целиком", async () => {
    const { app } = makeApp();
    const path = await createRepo(app);
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0-1.x86_64", repositories: ["a"], file: "artifact" },
    });
    expect(existsSync(join(path, "nginx-1.0.0-1.x86_64.rpm"))).toBe(true);
    const res = await json(app, "/api/packages/nginx", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await json(app, "/api/packages/nginx")).status).toBe(404);
    expect(existsSync(join(path, "nginx-1.0.0-1.x86_64.rpm"))).toBe(false);
  });

  // Удаление версии: файл, запись версии и журналы этой версии.
  it("удаляет версию и её файл из всех репозиториев", async () => {
    const { app } = makeApp();
    const path = await createRepo(app);
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0-1.x86_64", repositories: ["a"], file: "artifact" },
    });
    expect(existsSync(join(path, "nginx-1.0.0-1.x86_64.rpm"))).toBe(true);
    const res = await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(existsSync(join(path, "nginx-1.0.0-1.x86_64.rpm"))).toBe(false);
    const got = await json(app, "/api/packages/nginx");
    const body = (await got.json()) as { versions: Array<{ version: string }> };
    expect(body.versions.length).toBe(0);
    expect((await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64", { method: "DELETE" })).status).toBe(404);
  });
});

// PRS-07: ошибка несовпадения имени возвращается с фактическими (ожидаемыми) значениями;
// resolveName — сервер переименовывает файл под фактическое имя/версию.
describe("PRS-07 resolveName", () => {
  function renameRepo() {
    const dir = mkdtempSync(join(tmpdir(), "wm-test-"));
    mkdirSync(join(dir, "repodata"), { recursive: true });
    return dir;
  }

  it("возвращает фактическое имя/версию при несовпадении имени", async () => {
    const path = renameRepo();
    const { app } = makeApp({
      repoAdapter: {
        inspect: async () => ({ name: "httpd", version: "2.4.62-1.el9.x86_64" }),
        update: async () => {},
      },
    } as never);
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });
    const res = await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0-1.x86_64", repositories: ["a"], file: "content" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "artifact_name_mismatch",
      name: "httpd",
      version: "2.4.62-1.el9.x86_64",
    });
  });

  it("resolveName: размещает файл и запись под фактическим именем", async () => {
    const path = renameRepo();
    const { app } = makeApp({
      repoAdapter: {
        inspect: async () => ({ name: "httpd", version: "2.4.62-1.el9.x86_64" }),
        update: async () => {},
      },
    } as never);
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });
    const res = await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", repositories: ["a"], file: "content", resolveName: true },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; versions: Array<{ version: string }> };
    expect(body.name).toBe("httpd");
    expect(body.versions.map((v) => v.version)).toEqual(["2.4.62-1.el9.x86_64"]);
    expect(existsSync(join(path, "httpd-2.4.62-1.el9.x86_64.rpm"))).toBe(true);
    expect(existsSync(join(path, "nginx-1.0.0-1.x86_64.rpm"))).toBe(false);
    expect((await json(app, "/api/packages/nginx")).status).toBe(404);
  });

  it("PUT без resolveName: mismatch версии возвращает фактическую версию", async () => {
    const path = renameRepo();
    const { app } = makeApp({
      repoAdapter: {
        inspect: async () => ({ name: "nginx", version: "9.9.9-1.x86_64" }),
        update: async () => {},
      },
    } as never);
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0-1.x86_64", repositories: ["a"] },
    });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64", {
      method: "PUT",
      body: { file: "new" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "artifact_version_mismatch",
      version: "9.9.9-1.x86_64",
    });
  });

  it("PUT с resolveName: переписывает запись под фактическую версию", async () => {
    const path = renameRepo();
    const { app } = makeApp({
      repoAdapter: {
        inspect: async () => ({ name: "nginx", version: "9.9.9-1.x86_64" }),
        update: async () => {},
      },
    } as never);
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0-1.x86_64", repositories: ["a"] },
    });
    const res = await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64", {
      method: "PUT",
      body: { file: "new", resolveName: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ warning: true, version: "9.9.9-1.x86_64" });
    expect(existsSync(join(path, "nginx-1.0.0-1.x86_64.rpm"))).toBe(false);
    expect(existsSync(join(path, "nginx-9.9.9-1.x86_64.rpm"))).toBe(true);
    const got = await json(app, "/api/packages/nginx");
    const body = (await got.json()) as { versions: Array<{ version: string }> };
    expect(body.versions.map((v) => v.version)).toEqual(["9.9.9-1.x86_64"]);
  });
});