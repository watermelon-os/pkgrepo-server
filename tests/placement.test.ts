import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { makeApp, json } from "./helpers.js";

describe("placement between repositories", () => {
  const badRepo = "/proc/definitely/not/a/repo";

  // MOV-02. Пустой список репозиториев
  // - Когда: новый список репозиториев устанавливается пустым
  // - Тогда: ошибка
  it("отклоняет пустой список репозиториев", async () => {
    const { app } = makeApp({ fsRoot: mkdtempSync(join(tmpdir(), "wm-test-")) });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const res = await json(app, "/api/packages/nginx", {
      method: "PATCH",
      body: { repositories: [] },
    });
    expect(res.status).toBe(400);
  });

  // MOV-01. Несуществующий репозиторий
  // - Когда: в списке репозиториев есть несуществующий (или не проинициализированный)
  // - Тогда: ошибка
  it("отклоняет несуществующий репозиторий", async () => {
    const { app } = makeApp({ fsRoot: mkdtempSync(join(tmpdir(), "wm-test-")) });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const res = await json(app, "/api/packages/nginx", {
      method: "PATCH",
      body: { repositories: ["/good/repo", badRepo] },
    });
    expect(res.status).toBe(400);
  });

  // MOV-03. Частичный сбой
  it("возвращает ошибку при частичном сбое и не применяет изменения", async () => {
    const goodRepo = mkdtempSync(join(tmpdir(), "wm-test-"));
    const { app } = makeApp({ fsRoot: goodRepo });
    await json(app, "/api/packages", {
      method: "POST",
      body: { name: "nginx", version: "1.0.0" },
    });
    const res = await json(app, "/api/packages/nginx", {
      method: "PATCH",
      body: { repositories: [goodRepo, badRepo] },
    });
    expect(res.status).toBe(400);

    const got = await json(app, "/api/packages/nginx");
    const body = (await got.json()) as { repositories?: string[] };
    expect(body.repositories).not.toContain(badRepo);
  });

  // MOV-04. Репозиторий — свойство пакета
  it("не трогает журналы и статусы при смене репозиториев", async () => {
    const fsRoot = mkdtempSync(join(tmpdir(), "wm-test-"));
    const repo = mkdtempSync(join(tmpdir(), "wm-test-"));
    const { app } = makeApp({ fsRoot, commonBuildUrl: "http://node/build" });
    await json(app, "/api/packages", { method: "POST", body: { name: "nginx" } });
    const start = await json(app, "/api/packages/nginx/build", {
      method: "POST",
      body: { version: "any" },
    });
    const { id } = (await start.json()) as { id: string };
    await json(app, `/api/packages/nginx/build/${id}/callback`, {
      method: "POST",
      body: { result: "ok", version: "1.0.0" },
    });

    const move = await json(app, "/api/packages/nginx", {
      method: "PATCH",
      body: { repositories: [repo] },
    });
    expect(move.status).toBe(200);

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ versions: Array<{ buildStatus?: string }> }>;
    };
    expect(body.packages[0].versions[0].buildStatus).toBe("ok");
  });
});