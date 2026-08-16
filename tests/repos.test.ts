import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { makeApp, json } from "./helpers.js";

function rpmRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wm-test-"));
  mkdirSync(join(dir, "repodata"), { recursive: true });
  return dir;
}

function debRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wm-test-"));
  writeFileSync(join(dir, "Packages"), "");
  return dir;
}

function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), "wm-test-"));
}

describe("repositories", () => {
  // REP-01. Создание репозитория
  it("создает репозиторий по проинициализированной директории", async () => {
    const path = rpmRepo();
    const { app } = makeApp();
    const res = await json(app, "/api/repos", {
      method: "POST",
      body: { name: "main", path, type: "rpm" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; path: string; type: string };
    expect(body.name).toBe("main");
    expect(body.path).toBe(path);
    expect(body.type).toBe("rpm");
  });

  // REP-02. Создание с несуществующей директорией
  it("отклоняет репозиторий с несуществующим путём", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/repos", {
      method: "POST",
      body: { name: "main", path: "/no/such/dir", type: "rpm" },
    });
    expect(res.status).toBe(400);
  });

  // REP-03. Создание с непроинициализированной директорией
  it("отклоняет репозиторий без маркеров типа", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/repos", {
      method: "POST",
      body: { name: "main", path: emptyDir(), type: "rpm" },
    });
    expect(res.status).toBe(400);
  });

  // REP-04. Дубликат имени репозитория
  it("отклоняет дубликат имени репозитория", async () => {
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "main", path: rpmRepo(), type: "rpm" },
    });
    const dup = await json(app, "/api/repos", {
      method: "POST",
      body: { name: "main", path: rpmRepo(), type: "rpm" },
    });
    expect(dup.status).toBe(409);
  });

  // REP-05. Список репозиториев
  it("возвращает список репозиториев", async () => {
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "main", path: rpmRepo(), type: "rpm" },
    });
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "stable", path: debRepo(), type: "deb" },
    });
    const res = await json(app, "/api/repos");
    const body = (await res.json()) as { repositories: Array<{ name: string }> };
    expect(body.repositories.map((r) => r.name).sort()).toEqual(["main", "stable"]);
  });

  // REP-06. Получение репозитория
  it("возвращает репозиторий по имени", async () => {
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "main", path: rpmRepo(), type: "rpm" },
    });
    const res = await json(app, "/api/repos/main");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("main");
  });

  it("ошибка при запросе несуществующего репозитория", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/repos/missing");
    expect(res.status).toBe(404);
  });

  // REP-07. Удаление репозитория
  it("удаляет репозиторий и убирает его из свойств пакетов", async () => {
    const path = rpmRepo();
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "main", path, type: "rpm" },
    });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0-1.x86_64", repositories: ["main"], file: "content" },
    });

    const del = await json(app, "/api/repos/main", { method: "DELETE" });
    expect(del.status).toBe(204);

    const got = await json(app, "/api/packages/nginx");
    const body = (await got.json()) as { repositories?: string[] };
    expect(body.repositories).toEqual([]);
  });
});

describe("placement between repositories", () => {
  // MOV-01. Несуществующий репозиторий
  it("отклоняет размещение в несуществующий репозиторий", async () => {
    const { app } = makeApp();
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    const res = await json(app, "/api/packages/nginx", {
      method: "PATCH",
      body: { repositories: ["ghost"] },
    });
    expect(res.status).toBe(400);
  });

  // MOV-02. Пустой список репозиториев
  it("отклоняет пустой список репозиториев", async () => {
    const { app } = makeApp();
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    const res = await json(app, "/api/packages/nginx", {
      method: "PATCH",
      body: { repositories: [] },
    });
    expect(res.status).toBe(400);
  });

  // MOV-03. Частичный сбой — ошибка, атомарность
  it("возвращает ошибку при размещении в несуществующий среди списка и не применяет изменения", async () => {
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "main", path: rpmRepo(), type: "rpm" },
    });
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    const res = await json(app, "/api/packages/nginx", {
      method: "PATCH",
      body: { repositories: ["main", "ghost"] },
    });
    expect(res.status).toBe(400);
    const got = await json(app, "/api/packages/nginx");
    const body = (await got.json()) as { repositories?: string[] };
    expect(body.repositories).not.toContain("main");
  });

  // MOV-04. Репозиторий — свойство пакета; файл появляется в каждом репозитории
  it("раскладывает файл в каждый репозиторий пакета", async () => {
    const pathA = rpmRepo();
    const pathB = rpmRepo();
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path: pathA, type: "rpm" },
    });
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "b", path: pathB, type: "rpm" },
    });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0-1.x86_64", repositories: ["a", "b"], file: "content" },
    });

    expect(existsSync(join(pathA, "nginx-1.0.0-1.x86_64.rpm"))).toBe(true);
    expect(existsSync(join(pathB, "nginx-1.0.0-1.x86_64.rpm"))).toBe(true);
  });

  // MOV-05. Обновление бд репозитория при добавлении/перезаписи файла
  it("вызывает репо-адаптер при добавлении файла", async () => {
    const path = rpmRepo();
    const updates: string[] = [];
    const { app } = makeApp({
      fsRoot: "/tmp",
      repoAdapter: {
        inspect: async () => ({ name: "nginx", version: "1.0.0-1.x86_64" }),
        update: async (_dir: string, _type: string, name: string) => {
          updates.push(name);
        },
      },
    } as never);
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0-1.x86_64", repositories: ["a"], file: "content" },
    });
    expect(updates).toContain("nginx");
  });

  // MOV-06. Размещение обязательно при добавлении файла
  it("отклоняет добавление файла без размещения", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0", file: "content" },
    });
    expect(res.status).toBe(400);
  });
});
