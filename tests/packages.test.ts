import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, it, expect } from "vitest";
import * as schema from "../src/db/schema.js";
import { versions } from "../src/db/schema.js";
import { makeApp, json, binary, seedRepo, seedPackage } from "./helpers.js";

async function createRepo(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
  return seedRepo(app);
}

describe("packages API", () => {
  // ADD-01 — пакет сразу с первой версией; имя/версия разбираются из файла (NM-06)
  it("создаёт пакет сразу с первой версией при добавлении с файлом", async () => {
    const { app } = makeApp();
    await createRepo(app);
    const res = await json(app, "/api/packages", {
      method: "POST",
      body: { filename: "nginx-1.0.0-1.x86_64.rpm", repositories: ["a"], file: "artifact" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; versions: Array<{ version: string }> };
    expect(body.name).toBe("nginx");
    expect(body.versions.map((v) => v.version)).toEqual(["1.0.0-1.x86_64"]);
  });

  // Фантомов больше нет: имя создается только загрузкой файла.
  it("отклоняет создание имени без файла", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/packages", { method: "POST", body: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "file_required" });
  });

  // ADD-03 — повторное добавление той же версии — ошибка
  it("отклоняет повторное добавление той же версии", async () => {
    const { app } = makeApp();
    await createRepo(app);
    await seedPackage(app, "nginx", "1.0.0-1.x86_64");
    const dup = await json(app, "/api/packages/nginx/versions", {
      method: "POST",
      body: { filename: "nginx-1.0.0-1.x86_64.rpm", file: "other" },
    });
    expect(dup.status).toBe(409);
  });

  // PKG-01 — обращение к несуществующему пакету — ошибка
  it("возвращает ошибку для несуществующего пакета", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/packages/missing");
    expect(res.status).toBe(404);
  });

  // UPD-01 — перезапись при разной хэшсумме, возвращается варнинг
  it("перезаписывает файл и возвращает варнинг при разной хэшсумме", async () => {
    const { app } = makeApp();
    await createRepo(app);
    await seedPackage(app, "nginx", "1.0.0-1.x86_64");
    const res = await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64", {
      method: "PUT",
      body: { filename: "nginx-1.0.0-1.x86_64.rpm", file: "new" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warning?: boolean };
    expect(body.warning).toBe(true);
  });

  // UPD-02 — полное совпадение параметров — ошибка
  it("отклоняет обновление при полном совпадении параметров", async () => {
    const { app } = makeApp();
    await createRepo(app);
    await seedPackage(app, "nginx", "1.0.0-1.x86_64");
    const res = await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64", {
      method: "PUT",
      body: { filename: "nginx-1.0.0-1.x86_64.rpm", file: "artifact:nginx:1.0.0-1.x86_64" },
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

  // UPD-04. Сбой записи файла
  it("не фиксирует операцию при сбое записи файла", async () => {
    // Первый вызов update (создание) проходит; далее — сбой.
    let updates = 0;
    const { app } = makeApp({
      repoAdapter: {
        inspect: async () => ({ name: "nginx", version: "1.0.0-1.x86_64" }),
        update: async () => {
          if (updates++ > 0) throw new Error("repo db update failed");
        },
      },
    } as never);
    await createRepo(app);
    await seedPackage(app, "nginx", "1.0.0-1.x86_64");
    const res = await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64", {
      method: "PUT",
      body: { filename: "nginx-1.0.0-1.x86_64.rpm", file: "new" },
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
    migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
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
      body: { filename: "nginx-1.0.0-1.x86_64.rpm", repositories: ["a"], file: "content" },
    });
    expect(res.status).toBe(500);
    expect(existsSync(artifact)).toBe(false);
  });

  // DEL-01. Удаление всего, что связано
  it("удаляет пакет целиком", async () => {
    const { app } = makeApp();
    const path = await createRepo(app);
    await seedPackage(app, "nginx", "1.0.0-1.x86_64");
    expect(existsSync(join(path, "nginx-1.0.0-1.x86_64.rpm"))).toBe(true);
    const res = await json(app, "/api/packages/nginx", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await json(app, "/api/packages/nginx")).status).toBe(404);
    expect(existsSync(join(path, "nginx-1.0.0-1.x86_64.rpm"))).toBe(false);
  });

  // Удаление версии: файл и запись версии.
  it("удаляет версию и её файл из всех репозиториев", async () => {
    const { app } = makeApp();
    const path = await createRepo(app);
    await seedPackage(app, "nginx", "1.0.0-1.x86_64");
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

// NM-06/PRS-06: имя и версия не задаются в запросе — только из метаданных файла.
// PRS-07: расхождение фактического имени/версии с адресом версии — всегда ошибка,
// клиенту возвращаются фактические значения из метаданных.
describe("PRS-06/07 имя из файла и расхождения", () => {
  function renameRepo() {
    const dir = mkdtempSync(join(tmpdir(), "wm-test-"));
    mkdirSync(join(dir, "repodata"), { recursive: true });
    return dir;
  }

  it("имя и версия определяются только содержимым файла", async () => {
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
      body: { filename: "whatever-0.0.0-1.x86_64.rpm", repositories: ["a"], file: "content" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; versions: Array<{ version: string }> };
    expect(body.name).toBe("httpd");
    expect(body.versions.map((v) => v.version)).toEqual(["2.4.62-1.el9.x86_64"]);
    expect(existsSync(join(path, "httpd-2.4.62-1.el9.x86_64.rpm"))).toBe(true);
  });

  it("неразбираемый файл — ошибка", async () => {
    const { app } = makeApp();
    await createRepo(app);
    const res = await json(app, "/api/packages", {
      method: "POST",
      body: { repositories: ["a"], file: "not a package" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "artifact_unparseable" });
  });

  it("PUT: mismatch имени возвращает фактическое имя", async () => {
    const path = renameRepo();
    let calls = 0;
    const { app } = makeApp({
      repoAdapter: {
        inspect: async () =>
          calls++ === 0
            ? { name: "nginx", version: "1.0.0-1.x86_64" }
            : { name: "httpd", version: "2.0.0-1.x86_64" },
        update: async () => {},
      },
    } as never);
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });
    await seedPackage(app, "nginx", "1.0.0-1.x86_64");
    const res = await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64", {
      method: "PUT",
      body: { file: "new" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "artifact_name_mismatch", name: "httpd" });
  });

  it("PUT: mismatch версии возвращает фактическую версию", async () => {
    const path = renameRepo();
    let calls = 0;
    const { app } = makeApp({
      repoAdapter: {
        inspect: async () =>
          calls++ === 0
            ? { name: "nginx", version: "1.0.0-1.x86_64" }
            : { name: "nginx", version: "9.9.9-1.x86_64" },
        update: async () => {},
      },
    } as never);
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });
    await seedPackage(app, "nginx", "1.0.0-1.x86_64");
    const res = await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64", {
      method: "PUT",
      body: { file: "new" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "artifact_version_mismatch",
      version: "9.9.9-1.x86_64",
    });
    // Запись не изменилась.
    const got = await json(app, "/api/packages/nginx");
    const body = (await got.json()) as { versions: Array<{ version: string }> };
    expect(body.versions.map((v) => v.version)).toEqual(["1.0.0-1.x86_64"]);
  });
});

// PRS-06: бинарная загрузка — файл в теле запроса (Content-Type: application/octet-stream),
// параметры — в query. JSON-формат (file-строка) остаётся.
describe("PRS-06 бинарная загрузка (octet-stream + query)", () => {
  it("создаёт пакет из бинарного тела с параметрами в query", async () => {
    const { app } = makeApp();
    const path = await createRepo(app);
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0xff]);
    const res = await binary(
      app,
      "/api/packages?filename=nginx-1.0.0-1.x86_64.rpm&repositories=a",
      { method: "POST", body: bytes },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; versions: Array<{ version: string }> };
    expect(body.name).toBe("nginx");
    expect(body.versions.map((v) => v.version)).toEqual(["1.0.0-1.x86_64"]);
    expect(readFileSync(join(path, "nginx-1.0.0-1.x86_64.rpm")).equals(bytes)).toBe(true);
  });

  it("добавляет версию из бинарного тела (query: filename)", async () => {
    const { app } = makeApp();
    await createRepo(app);
    await seedPackage(app, "nginx", "1.0.0-1.x86_64");
    const res = await binary(
      app,
      "/api/packages/nginx/versions?filename=nginx-2.0.0-1.x86_64.rpm",
      { method: "POST", body: Buffer.from("v2") },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { versions: Array<{ version: string }> };
    expect(body.versions.map((v) => v.version)).toEqual(["1.0.0-1.x86_64", "2.0.0-1.x86_64"]);
  });

  it("перезаписывает файл бинарным телом (PUT + query)", async () => {
    const { app } = makeApp();
    const path = await createRepo(app);
    await seedPackage(app, "nginx", "1.0.0-1.x86_64");
    const res = await binary(
      app,
      "/api/packages/nginx/versions/1.0.0-1.x86_64?filename=nginx-1.0.0-1.x86_64.rpm",
      { method: "PUT", body: Buffer.from("new-bytes") },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ warning: true });
    expect(readFileSync(join(path, "nginx-1.0.0-1.x86_64.rpm")).equals(Buffer.from("new-bytes"))).toBe(true);
  });

  it("принимает бинарное тело и без content-type (как Rext @body)", async () => {
    const { app } = makeApp();
    const path = await createRepo(app);
    const res = await app.request(
      "/api/packages?filename=nginx-1.0.0-1.x86_64.rpm&repositories=a",
      { method: "POST", body: Buffer.from("no-ct") },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { versions: Array<{ version: string }> };
    expect(body.versions.map((v) => v.version)).toEqual(["1.0.0-1.x86_64"]);
    expect(readFileSync(join(path, "nginx-1.0.0-1.x86_64.rpm")).equals(Buffer.from("no-ct"))).toBe(true);
  });

  it("отклоняет загрузку без репозиториев", async () => {
    const { app } = makeApp();
    await createRepo(app);
    const res = await binary(app, "/api/packages?filename=nginx-1.0.0-1.x86_64.rpm", {
      method: "POST",
      body: Buffer.from("x"),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_repositories" });
  });

  it("отклоняет добавление версии без файла", async () => {
    const { app } = makeApp();
    await createRepo(app);
    await seedPackage(app, "nginx", "1.0.0-1.x86_64");
    const res = await binary(app, "/api/packages/nginx/versions", {
      method: "POST",
      body: Buffer.alloc(0),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "file_required" });
  });

  it("отклоняет бинарный запрос с несуществующим репозиторием", async () => {
    const { app } = makeApp();
    const res = await binary(
      app,
      "/api/packages?filename=nginx-1.0.0-1.x86_64.rpm&repositories=missing",
      { method: "POST", body: Buffer.from("x") },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "repository_not_found" });
  });
});
