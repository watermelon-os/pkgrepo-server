import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { makeApp, json, memoryLogger } from "./helpers.js";

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

    writeFileSync(join(path, "nginx-1.0.0-1.x86_64.rpm"), "content");

    const res = await json(app, "/api/packages/sync", { method: "POST" });
    expect(res.status).toBe(200);

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ name: string; versions: Array<{ version: string }> }>;
    };
    expect(body.packages[0]!.name).toBe("nginx");
    expect(body.packages[0]!.versions.map((v) => v.version)).toContain("1.0.0-1.x86_64");
  });

  // - Тогда: разбор артефакта выполняется по шаблону (например `{name}-{version}-{release}.{arch}.rpm`)
  it("разбирает имя файла по шаблону name-version-release.arch", async () => {
    const path = rpmRepo();
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    writeFileSync(join(path, "nginx-1.0.0-1.x86_64.rpm"), "content");
    await json(app, "/api/packages/sync", { method: "POST" });

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ versions: Array<{ version: string }> }>;
    };
    expect(body.packages[0]!.versions[0]!.version).toBe("1.0.0-1.x86_64");
  });

  // - Тогда: сканируются только файлы с расширением, характерным для типа репозитория;
  //   файлы иных расширений игнорируются
  it("игнорирует файлы чужих расширений", async () => {
    const path = rpmRepo();
    const { logger, lines } = memoryLogger();
    const { app } = makeApp({ logger });
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    writeFileSync(join(path, "notes.txt"), "content");
    writeFileSync(join(path, "README.md"), "content");

    const res = await json(app, "/api/packages/sync", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { picked: number }).picked).toBe(0);
    expect(lines.join("\n")).not.toContain("cannot parse artifact");

    const got = await json(app, "/api/packages");
    expect(((await got.json()) as { packages: unknown[] }).packages).toEqual([]);
  });

  // - Тогда: неразбираемое имя файла только логируется, ошибкой не становится
  it("логирует неразбираемое имя, но не падает", async () => {
    const path = rpmRepo();
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    writeFileSync(join(path, "not-a-package.rpm"), "content");

    const res = await json(app, "/api/packages/sync", { method: "POST" });
    expect(res.status).toBe(200);
  });

  // Каталог индекса (repodata) и не-.rpm файлы — не артефакты.
  it("пропускает индекс репозитория и не шумит в лог", async () => {
    const rpmDir = rpmRepo();
    // Индексный файл без расширения .rpm и чужой артефакт в корне репозитория.
    writeFileSync(join(rpmDir, "repomd.xml"), "<metadata/>");
    writeFileSync(join(rpmDir, "README.txt"), "not a package");

    const { logger, lines } = memoryLogger();
    const { app } = makeApp({ logger });
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "r", path: rpmDir, type: "rpm" },
    });

    const res = await json(app, "/api/packages/sync", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { picked: number }).picked).toBe(0);
    expect(lines.join("\n")).not.toContain("cannot parse artifact");

    const got = await json(app, "/api/packages");
    expect(((await got.json()) as { packages: unknown[] }).packages).toEqual([]);
  });

  // - Тогда: повторный скан идемпотентен — дубликатов не появляется
  it("идемпотентен при повторном скане", async () => {
    const path = rpmRepo();
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    writeFileSync(join(path, "nginx-1.0.0-1.x86_64.rpm"), "content");
    await json(app, "/api/packages/sync", { method: "POST" });
    await json(app, "/api/packages/sync", { method: "POST" });

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ versions: Array<{ version: string }> }>;
    };
    expect(body.packages[0]!.versions.filter((v) => v.version === "1.0.0-1.x86_64")).toHaveLength(1);
  });

  // Файл, исчезнувший с диска, не удаляет запись (ATOM-консерватизм)
  it("не удаляет запись при исчезновении файла", async () => {
    const path = rpmRepo();
    const { app } = makeApp();
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    writeFileSync(join(path, "nginx-1.0.0-1.x86_64.rpm"), "content");
    await json(app, "/api/packages/sync", { method: "POST" });

    await import("node:fs").then((fs) => fs.rmSync(join(path, "nginx-1.0.0-1.x86_64.rpm")));
    await json(app, "/api/packages/sync", { method: "POST" });

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ versions: Array<{ version: string }> }>;
    };
    expect(body.packages[0]!.versions.map((v) => v.version)).toContain("1.0.0-1.x86_64");
  });

  // Метаданные пакета (как их видит rpm -qp) могут не совпадать с именем файла
  // (например omv-сборки: vim-9.2.0920-1-omv2690.x86_64.rpm) — пакет всё равно
  // подхватывается, файл переименовывается в каноническое имя.
  it("подхватывает файл с неканоническим именем и переименовывает его", async () => {
    const path = rpmRepo();
    const { logger, lines } = memoryLogger();
    const repoAdapter = {
      inspect: async () => ({ name: "nginx", version: "1.0.0-1.x86_64" }),
      update: async () => {},
    };
    const { app } = makeApp({ logger, repoAdapter });
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    writeFileSync(join(path, "nginx-1.0.0-1-omv2690.x86_64.rpm"), "content");
    const res = await json(app, "/api/packages/sync", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { picked: number }).picked).toBe(1);

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ versions: Array<{ version: string }> }>;
    };
    expect(body.packages[0]!.versions.map((v) => v.version)).toContain("1.0.0-1.x86_64");

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(path, "nginx-1.0.0-1.x86_64.rpm"))).toBe(true);
    expect(existsSync(join(path, "nginx-1.0.0-1-omv2690.x86_64.rpm"))).toBe(false);
    expect(lines.join("\n")).toContain("sync: renamed artifact");

    // Повторный скан идемпотентен после переименования
    const again = await json(app, "/api/packages/sync", { method: "POST" });
    expect(((await again.json()) as { picked: number }).picked).toBe(0);
  });

  // Варнинг о нечитаемом артефакте содержит причину (errno/сообщение ОС)
  it("логирует причину, если файл-симлинк битый", async () => {
    const path = rpmRepo();
    const { logger, lines } = memoryLogger();
    const { app } = makeApp({ logger });
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(path, "missing-target.rpm"), join(path, "nginx-1.0.0-1.x86_64.rpm"));

    const res = await json(app, "/api/packages/sync", { method: "POST" });
    expect(res.status).toBe(200);
    expect(lines.join("\n")).toContain("sync: cannot read artifact");
    expect(lines.join("\n")).toMatch(/reason.*ENOENT/);
  });
});

// SYNC_LOG_EMPTY: скан без найденных пакетов можно не логировать.
describe("sync: логирование пустых сканов", () => {
  it("SYNC_LOG_EMPTY=false не пишет 'sync done' при нуле найденных", async () => {
    const path = rpmRepo();
    const { logger, lines } = memoryLogger();
    const { app } = makeApp({ logger, logEmptySync: false });
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    const res = await json(app, "/api/packages/sync", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { picked: number }).picked).toBe(0);
    expect(lines.join("\n")).not.toContain("sync done");
  });

  it("по умолчанию пустой скан логируется", async () => {
    const path = rpmRepo();
    const { logger, lines } = memoryLogger();
    const { app } = makeApp({ logger });
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    const res = await json(app, "/api/packages/sync", { method: "POST" });
    expect(res.status).toBe(200);
    expect(lines.join("\n")).toContain("sync done");
  });

  it("непустой скан логируется даже при SYNC_LOG_EMPTY=false", async () => {
    const path = rpmRepo();
    writeFileSync(join(path, "nginx-1.0.0-1.x86_64.rpm"), "content");
    const { logger, lines } = memoryLogger();
    const { app } = makeApp({ logger, logEmptySync: false });
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "a", path, type: "rpm" },
    });

    const res = await json(app, "/api/packages/sync", { method: "POST" });
    expect(((await res.json()) as { picked: number }).picked).toBe(1);
    expect(lines.join("\n")).toContain("sync done");
  });
});
