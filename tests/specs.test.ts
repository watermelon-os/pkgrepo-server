import { describe, it, expect } from "vitest";
import { makeApp, json, binary, seedRepo, seedPackage, seedSpec, makeSpecText } from "./helpers.js";

describe("specs API", () => {
  // NM-01/NM-06. Создание имени загрузкой спека: имя разбирается из содержимого,
  // в запросе не задается.
  it("создает имя и запись спека при первой загрузке", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/specs", {
      method: "POST",
      body: { file: makeSpecText("nginx", "1.24.0") },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "nginx", version: "1.24.0-1" });

    // Имя появилось в общем списке пакетов.
    const got = await json(app, "/api/packages");
    const body = (await got.json()) as { packages: Array<{ name: string }> };
    expect(body.packages.map((p) => p.name)).toEqual(["nginx"]);
  });

  // NM-05. Невалидный спек — ошибка, имя не создается
  it("отклоняет спек без тегов Name/Version", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/specs", {
      method: "POST",
      body: { file: "Summary: nothing here\n" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid_spec",
      message: "no Name/Version tags found",
    });
    const got = await json(app, "/api/packages/nginx");
    expect(got.status).toBe(404);
  });

  // RPM-макросы в значениях тегов: %{?dist} без определения → пусто.
  it("принимает Release с %{?dist}", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/specs", {
      method: "POST",
      body: { file: makeSpecText("nginx", "1.24.0", "1%{?dist}") },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "nginx", version: "1.24.0-1" });
  });

  // Подстановка %{name} и %{version} из самих тегов.
  it("раскрывает %{name}/%{version} в других тегах", async () => {
    const { app } = makeApp();
    const file = [
      "Name:           hello",
      "Version:        2.10",
      "Release:        1%{?dist}",
      "Source0:        https://example.com/%{name}-%{version}.tar.gz",
      "",
      "%description",
      "test",
    ].join("\n");
    const res = await json(app, "/api/specs", { method: "POST", body: { file } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "hello", version: "2.10-1" });
  });

  // Макросы из %global/%define раскрываются.
  it("раскрывает макросы из %global/%define", async () => {
    const { app } = makeApp();
    const file = [
      "%global package_version 3.5",
      "%define pkg_release 2%{?dist}",
      "Name:           mypkg",
      "Version:        %{package_version}",
      "Release:        %{pkg_release}",
      "",
      "%description",
      "test",
    ].join("\n");
    const res = await json(app, "/api/specs", { method: "POST", body: { file } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "mypkg", version: "3.5-2" });
  });

  // Нераскрываемый макрос — ошибка с причиной в ответе.
  it("отклоняет нераскрываемый макрос с message в ответе", async () => {
    const { app } = makeApp();
    const res = await json(app, "/api/specs", {
      method: "POST",
      body: { file: "Name: x\nVersion: %{package_version}\n" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_spec");
    expect(body.message).toContain("%{package_version}");
  });

  // Несколько спеков у имени (каждый со своей версией)
  it("принимает несколько спеков с разными версиями", async () => {
    const { app } = makeApp();
    expect(
      (await json(app, "/api/specs", { method: "POST", body: { file: makeSpecText("nginx", "1.24.0", "1") } })).status,
    ).toBe(201);
    expect(
      (await json(app, "/api/specs", { method: "POST", body: { file: makeSpecText("nginx", "1.26.0", "1") } })).status,
    ).toBe(201);

    const list = await json(app, "/api/names/nginx/specs");
    const body = (await list.json()) as { specs: Array<{ version: string }> };
    expect(body.specs.map((s) => s.version)).toEqual(["1.24.0-1", "1.26.0-1"]);
  });

  // Скачивание спека по версии
  it("отдает содержимое спека по его версии", async () => {
    const { app } = makeApp();
    await json(app, "/api/specs", {
      method: "POST",
      body: { file: makeSpecText("nginx", "1.24.0") },
    });
    const res = await json(app, "/api/names/nginx/specs/1.24.0-1");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(makeSpecText("nginx", "1.24.0"));
    expect((await json(app, "/api/names/nginx/specs/9.9.9")).status).toBe(404);
  });

  it("принимает спек бинарным телом", async () => {
    const { app } = makeApp();
    const res = await binary(app, "/api/specs?override=true", {
      method: "POST",
      body: Buffer.from(makeSpecText("redis", "7.0.0"), "utf8"),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "redis", version: "7.0.0-1" });
  });
});

describe("NM-03 дедуп спеков", () => {
  // NM-03. Дедуп по хэшу содержимого; дубль без override — ошибка
  it("отклоняет повторную загрузку идентичного спека", async () => {
    const { app } = makeApp();
    const spec = makeSpecText("nginx", "1.24.0");
    await json(app, "/api/specs", { method: "POST", body: { file: spec } });
    const dup = await json(app, "/api/specs", { method: "POST", body: { file: spec } });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "spec_exists", version: "1.24.0-1" });
  });

  it("отклоняет другой контент под той же версией без override", async () => {
    const { app } = makeApp();
    await json(app, "/api/specs", {
      method: "POST",
      body: { file: makeSpecText("nginx", "1.24.0") },
    });
    const other = makeSpecText("nginx", "1.24.0").replace("Summary:        Test spec", "Summary:        Changed");
    const dup = await json(app, "/api/specs", { method: "POST", body: { file: other } });
    expect(dup.status).toBe(409);
  });

  // NM-03 override: перезапись записи на месте, ссылки не ломаются
  it("override перезаписывает спек, ссылки версий сохраняются", async () => {
    const { app } = makeApp();
    await seedRepo(app);
    await seedSpec(app, "nginx", "1.24.0");
    expect(
      (await json(app, "/api/packages/nginx", { method: "PATCH", body: { repositories: ["a"] } })).status,
    ).toBe(200);
    // Артефакт привязан к спеку (имя уже создано спеком).
    const created = await json(app, "/api/packages/nginx/versions", {
      method: "POST",
      body: { filename: "nginx-1.24.0-1.x86_64.rpm", file: "artifact", specVersion: "1.24.0-1" },
    });
    expect(created.status).toBe(201);

    const changed = makeSpecText("nginx", "1.24.0").replace("Test spec", "Patched spec");
    const res = await json(app, "/api/specs", {
      method: "POST",
      body: { file: changed, override: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ overridden: true, version: "1.24.0-1" });

    // Ссылка жива, содержимое обновилось.
    const linked = await json(app, "/api/packages/nginx/versions/1.24.0-1.x86_64/spec");
    expect(linked.status).toBe(200);
    expect(await linked.text()).toBe(changed);
  });
});

describe("поиск спеков", () => {
  // Поиск по имени, версии и релизу
  it("фильтрует по имени, версии и релизу", async () => {
    const { app } = makeApp();
    await seedSpec(app, "nginx", "1.24.0", "1");
    await seedSpec(app, "nginx", "1.24.0", "2.el9");
    await seedSpec(app, "redis", "7.0.0", "1");

    const byName = (await (await json(app, "/api/specs?name=ng*")).json()) as {
      specs: Array<{ name: string }>;
    };
    expect(byName.specs).toHaveLength(2);

    const byVersion = (await (await json(app, "/api/specs?name=nginx&version=1.24.0-*")).json()) as {
      specs: Array<{ version: string }>;
    };
    expect(byVersion.specs).toHaveLength(2);

    const byRelease = (await (await json(app, "/api/specs?name=nginx&release=2*")).json()) as {
      specs: Array<{ version: string }>;
    };
    expect(byRelease.specs.map((s) => s.version)).toEqual(["1.24.0-2.el9"]);

    const all = (await (await json(app, "/api/specs")).json()) as { specs: unknown[] };
    expect(all.specs).toHaveLength(3);
  });
});

describe("привязка артефакта к спеку", () => {
  it("возвращает спек собранного пакета по имени/версии/релизу", async () => {
    const { app } = makeApp();
    await seedRepo(app);
    await seedSpec(app, "nginx", "1.24.0", "1");
    expect(
      (await json(app, "/api/packages/nginx", { method: "PATCH", body: { repositories: ["a"] } })).status,
    ).toBe(200);
    await json(app, "/api/packages/nginx/versions", {
      method: "POST",
      body: { filename: "nginx-1.24.0-1.x86_64.rpm", file: "artifact", specVersion: "1.24.0-1" },
    });

    const res = await json(app, "/api/packages/nginx/versions/1.24.0-1.x86_64/spec");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(makeSpecText("nginx", "1.24.0", "1"));
  });

  it("404 для артефакта без привязанного спека", async () => {
    const { app } = makeApp();
    await seedRepo(app);
    await seedPackage(app, "nginx", "1.0.0-1.x86_64");
    const res = await json(app, "/api/packages/nginx/versions/1.0.0-1.x86_64/spec");
    expect(res.status).toBe(404);
  });

  it("отклоняет привязку к несуществующему спеку", async () => {
    const { app } = makeApp();
    await seedRepo(app);
    const res = await json(app, "/api/packages", {
      method: "POST",
      body: { filename: "nginx-1.0.0-1.x86_64.rpm", repositories: ["a"], file: "artifact", specVersion: "9.9.9" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "spec_not_found" });
  });

  it("принимает specVersion в query при бинарной загрузке", async () => {
    const { app } = makeApp();
    await seedRepo(app);
    await seedSpec(app, "nginx", "1.24.0");
    expect(
      (await json(app, "/api/packages/nginx", { method: "PATCH", body: { repositories: ["a"] } })).status,
    ).toBe(200);
    const res = await binary(
      app,
      "/api/packages/nginx/versions?filename=nginx-1.24.0-1.x86_64.rpm&specVersion=1.24.0-1",
      { method: "POST", body: Buffer.from("bytes") },
    );
    expect(res.status).toBe(201);
    const spec = await json(app, "/api/packages/nginx/versions/1.24.0-1.x86_64/spec");
    expect(spec.status).toBe(200);
  });
});
