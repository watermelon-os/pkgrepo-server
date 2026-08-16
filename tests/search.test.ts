import { describe, it, expect } from "vitest";
import { makeApp, json } from "./helpers.js";

describe("search API", () => {
  // SRCH-01. Пустой запрос
  // - Когда: задан пустой запрос (ни один фильтр не задан)
  // - Тогда: возвращаются все пакеты
  it("возвращает все пакеты при пустом запросе поиска", async () => {
    const { app } = makeApp();
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    await json(app, "/api/packages", { method: "POST", body: { name: "redis" } });

    const res = await json(app, "/api/packages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packages: Array<{ name: string }> };
    expect(body.packages.map((p) => p.name).sort()).toEqual(["nginx", "redis"]);
  });

  // SRCH-02. Комбинация фильтров
  it("возвращает пересечение при нескольких фильтрах", async () => {
    const { app } = makeApp();
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "2.0.0" },
    });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "redis", version: "7.0.0" },
    });

    const res = await json(app, "/api/packages?name=nginx&version=1.0.0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packages: Array<{ name: string }> };
    expect(body.packages.map((p) => p.name)).toEqual(["nginx"]);
  });

  // SRCH-03. Фильтр по имени
  it("возвращает все версии пакета плоским списком", async () => {
    const { app } = makeApp();
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "2.0.0" },
    });

    const res = await json(app, "/api/packages?name=nginx");
    const body = (await res.json()) as {
      packages: Array<{ name: string; versions: Array<{ version: string }> }>;
    };
    expect(body.packages.filter((p) => p.name === "nginx")[0].versions.map((v) => v.version)).toEqual(
      ["1.0.0", "2.0.0"],
    );
  });

  // SRCH-04. Точные совпадения и шаблоны
  it("поддерживает шаблоны ? и *", async () => {
    const { app } = makeApp();
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    await json(app, "/api/packages", { method: "POST", body: { name: "nngx" } });
    await json(app, "/api/packages", { method: "POST", body: { name: "redis" } });

    const star = await json(app, "/api/packages?name=ng*");
    const starBody = (await star.json()) as { packages: Array<{ name: string }> };
    expect(starBody.packages.map((p) => p.name).sort()).toEqual(["nginx", "nngx"]);

    const q = await json(app, "/api/packages?name=ng?nx");
    const qBody = (await q.json()) as { packages: Array<{ name: string }> };
    expect(qBody.packages.map((p) => p.name)).toEqual(["nginx"]);
  });

  // SRCH-05. Статус не определен
  it("не задевает пакеты без журналов при фильтре по статусу", async () => {
    const { app } = makeApp();
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });

    const res = await json(app, "/api/packages?status=ok");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packages: Array<{ name: string }> };
    expect(body.packages.map((p) => p.name)).not.toContain("nginx");
  });

  // SRCH-06. Полная информация
  it("возвращает полную информацию о пакетах", async () => {
    const { app } = makeApp();
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });

    const res = await json(app, "/api/packages?name=nginx");
    const body = (await res.json()) as {
      packages: Array<{
        name: string;
        versions: Array<{ version: string; repositories: string[] }>;
      }>;
    };
    const pkg = body.packages[0];
    expect(pkg.name).toBe("nginx");
    expect(pkg.versions[0].version).toBe("1.0.0");
    expect(Array.isArray(pkg.versions[0].repositories)).toBe(true);
  });
});