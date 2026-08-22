import { describe, it, expect } from "vitest";
import { makeApp, json, seedRepo, seedPackage } from "./helpers.js";

describe("placement between repositories", () => {
  // MOV-04. Репозиторий — свойство артефакта: затрагивается только размещение.
  it("меняет только размещение при смене репозиториев", async () => {
    const { app } = makeApp();
    await seedRepo(app, "a");
    await seedRepo(app, "main");
    await seedPackage(app, "nginx", "1.0.0-1.x86_64", "a");

    const move = await json(app, "/api/packages/nginx", {
      method: "PATCH",
      body: { repositories: ["main"] },
    });
    expect(move.status).toBe(200);
    const moved = (await move.json()) as {
      name: string;
      repositories: string[];
      versions: Array<{ version: string; repositories: string[] }>;
    };
    expect(moved.repositories).toEqual(["main"]);
    expect(moved.versions.map((v) => v.version)).toEqual(["1.0.0-1.x86_64"]);
    expect(moved.versions[0]!.repositories).toEqual(["main"]);

    // Данные пакета не изменились, кроме размещения.
    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ name: string; repositories: string[]; versions: Array<{ version: string }> }>;
    };
    expect(body.packages[0]!.name).toBe("nginx");
    expect(body.packages[0]!.repositories).toEqual(["main"]);
    expect(body.packages[0]!.versions.map((v) => v.version)).toEqual(["1.0.0-1.x86_64"]);
  });
});
