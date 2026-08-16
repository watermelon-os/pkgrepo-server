import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { makeApp, json } from "./helpers.js";

function rpmRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wm-test-"));
  mkdirSync(join(dir, "repodata"), { recursive: true });
  return dir;
}

describe("synchronization with fs", () => {
  // SVR-03. Синхронизация с фс
  // - Когда: сервер периодически сканирует репозитории (или по ручному запросу)
  // - Тогда: подхватываются пакеты/версии, появившиеся на диске вне API
  it("подхватывает файл, положенный в репозиторий вне API", async () => {
    const path = rpmRepo();
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    writeFileSync(join(path, "nginx-1.0.0.rpm"), "content");

    const res = await json(app, "/api/packages/sync", { method: "POST" });
    expect(res.status).toBe(200);

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ name: string; versions: Array<{ version: string }> }>;
    };
    expect(body.packages[0]!.name).toBe("nginx");
    expect(body.packages[0]!.versions.map((v) => v.version)).toContain("1.0.0");
  });

  // - Тогда: разбор имени файла выполняется по шаблону из конфига (например `{name}-{version}.rpm`)
  it("разбирает имя файла по шаблону name-version", async () => {
    const path = rpmRepo();
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    writeFileSync(join(path, "nginx-1.0.0.rpm"), "content");
    await json(app, "/api/packages/sync", { method: "POST" });

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ versions: Array<{ version: string }> }>;
    };
    expect(body.packages[0]!.versions[0]!.version).toBe("1.0.0");
  });

  // - Тогда: неразбираемое имя файла только логируется, ошибкой не становится
  it("логирует неразбираемое имя, но не падает", async () => {
    const path = rpmRepo();
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    writeFileSync(join(path, "not-a-package.txt"), "content");

    const res = await json(app, "/api/packages/sync", { method: "POST" });
    expect(res.status).toBe(200);
  });

  // - Тогда: повторный скан идемпотентен — дубликатов не появляется
  it("идемпотентен при повторном скане", async () => {
    const path = rpmRepo();
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    writeFileSync(join(path, "nginx-1.0.0.rpm"), "content");
    await json(app, "/api/packages/sync", { method: "POST" });
    await json(app, "/api/packages/sync", { method: "POST" });

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ versions: Array<{ version: string }> }>;
    };
    expect(body.packages[0]!.versions.filter((v) => v.version === "1.0.0")).toHaveLength(1);
  });

  // Файл, исчезнувший с диска, не удаляет запись (ATOM-консерватизм)
  it("не удаляет запись при исчезновении файла", async () => {
    const path = rpmRepo();
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    writeFileSync(join(path, "nginx-1.0.0.rpm"), "content");
    await json(app, "/api/packages/sync", { method: "POST" });

    await import("node:fs").then((fs) => fs.rmSync(join(path, "nginx-1.0.0.rpm")));
    await json(app, "/api/packages/sync", { method: "POST" });

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ versions: Array<{ version: string }> }>;
    };
    expect(body.packages[0]!.versions.map((v) => v.version)).toContain("1.0.0");
  });
});
