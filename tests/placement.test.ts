import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { makeApp, json } from "./helpers.js";

function rpmRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wm-test-"));
  mkdirSync(join(dir, "repodata"), { recursive: true });
  return dir;
}

describe("placement between repositories", () => {
  // MOV-04. Репозиторий — свойство пакета
  it("не трогает журналы и статусы при смене репозиториев", async () => {
    const { app } = makeApp({ commonBuildUrl: "http://node/build" });
    await json(app, "/api/repos", {
      method: "POST",
      body: { name: "main", path: rpmRepo(), type: "rpm" },
    });
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
      body: { repositories: ["main"] },
    });
    expect(move.status).toBe(200);

    const got = await json(app, "/api/packages?name=nginx");
    const body = (await got.json()) as {
      packages: Array<{ versions: Array<{ buildStatus?: string }> }>;
    };
    expect(body.packages[0]!.versions[0]!.buildStatus).toBe("ok");
  });
});