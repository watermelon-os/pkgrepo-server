import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Hono, type Context } from "hono";
import type { OrchClient } from "../app.js";
import { buildJournal, packages, repositories, testJournal, versions } from "../db/schema.js";
import { createLogger } from "../logger.js";
import type { PackageApiDeps } from "./packages/deps.js";
import { resolveAdapter } from "./packages/deps.js";
import {
  createBodySchema,
  nameSchema,
  repositoriesBodySchema,
  runBodySchema,
  updateBodySchema,
  versionBodySchema,
  versionSchema,
  versionUpdateBodySchema,
} from "./packages/schemas.js";
import {
  artifactErrorResponse,
  artifactExistsInRepos,
  ArtifactError,
  artifactFileName,
  ensurePackage,
  getPackage,
  isArtifactError,
  removeArtifactFromRepos,
  repositoryByIdentity,
  reposOf,
  sha256,
  writeArtifactToRepos,
  writeFileToRepos,
} from "./packages/artifacts.js";
import { buildPackageResponse } from "./packages/response.js";
import { startBuild, startTest } from "./packages/process.js";
import { runSync } from "./packages/sync.js";

export { runSync, type PackageApiDeps };

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`.*${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}.*`);
}

// PRS-07: бинарная загрузка — файл в теле запроса, метаданные (name/version/
// repositories/resolveName) — в query. Детекция: тело считается бинарным для
// любого content-type, кроме явного application/json (Rext может не ставить
// octet-stream для @body).
function isJsonRequest(c: Context): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
}

function queryBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === "true" || v === "1";
}

function queryRepositories(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const list = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return list.length === 0 ? undefined : list;
}

export function packageRoutes(deps: PackageApiDeps): Hono {
  const db = deps.db;
  const logger = deps.logger ?? createLogger({ level: "info" });
  const orch: OrchClient =
    deps.orch ?? { start: async () => ({ ok: true, error: undefined, response: undefined }) };
  const adapter = resolveAdapter(deps, logger);

  const app = new Hono();

  // SYNC: ручной запуск синхронизации с фс (SVR-03); та же логика — в таймере (index.ts).
  app.post("/sync", async (c) => {
    const result = await runSync(deps, c.get("reqId"));
    return c.json(result);
  });

  // SRCH-01..06. Поиск пакетов.
  app.get("/", (c) => {
    const namePattern = c.req.query("name");
    const versionFilter = c.req.query("version");
    const statusFilter = c.req.query("status");

    const all = db.select().from(packages).all();
    const filtered = all.filter((pkg) => {
      if (namePattern && !globToRegExp(namePattern).test(pkg.name)) return false;
      if (versionFilter) {
        const hasVersion = db
          .select()
          .from(versions)
          .where(
            and(
              eq(versions.packageName, pkg.name),
              eq(versions.version, versionFilter),
            ),
          )
          .get();
        if (!hasVersion) return false;
      }
      if (statusFilter) {
        const view = buildPackageResponse(deps, pkg);
        const matches = view.versions.some(
          (v) => v.testStatus === statusFilter || v.buildStatus === statusFilter,
        );
        if (!matches) return false;
      }
      return true;
    });

    return c.json({
      packages: filtered.map((pkg) => buildPackageResponse(deps, pkg)),
    });
  });

  // ADD-01..05. Создание пакета.
  app.post("/", async (c) => {
    const reqId = c.get("reqId");
    let body: z.infer<typeof createBodySchema>;
    let file: Uint8Array | undefined;
    try {
      if (isJsonRequest(c)) {
        body = createBodySchema.parse(await c.req.json());
        if (body.file !== undefined) file = Buffer.from(body.file, "utf8");
      } else {
        // PRS-07: файл — бинарное тело запроса; метаданные — в query.
        file = new Uint8Array(await c.req.arrayBuffer());
        body = createBodySchema.parse({
          name: c.req.query("name") ?? "",
          version: c.req.query("version") ?? undefined,
          repositories: queryRepositories(c.req.query("repositories")),
          resolveName: queryBool(c.req.query("resolveName")),
          testUrl: c.req.query("testUrl") ?? undefined,
          buildUrl: c.req.query("buildUrl") ?? undefined,
        });
      }
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    const existing = getPackage(db, body.name);
    if (existing) {
      // ADD-04: фантом при существующем пакете — ошибка.
      return c.json({ error: "package_exists" }, 409);
    }
    if (file !== undefined) {
      // MOV-06: размещение обязательно при добавлении файла.
      if (!body.repositories || body.repositories.length === 0) {
        return c.json({ error: "no_repositories" }, 400);
      }
      // MOV-01: репозиторий должен существовать.
      for (const repoName of body.repositories) {
        if (!repositoryByIdentity(db, repoName)) {
          return c.json({ error: "repository_not_found", repository: repoName }, 400);
        }
      }
    }
    const now = new Date();
    db.insert(packages)
      .values({
        name: body.name,
        testUrl: body.testUrl ?? null,
        buildUrl: body.buildUrl ?? null,
        repositories: body.repositories ?? [],
        createdAt: now,
      })
      .run();

    const pkg = getPackage(db, body.name)!;
    let effectivePkg: typeof pkg = pkg;
    if (file !== undefined) {
      // Атомарность: сначала фс, потом бд; при сбое бд — компенсация.
      let derived;
      try {
        derived = await writeArtifactToRepos(
          db,
          pkg,
          body.name,
          body.version ?? "",
          file,
          adapter,
          body.resolveName === true,
        );
      } catch (error) {
        if (isArtifactError(error)) return artifactErrorResponse(c, error);
        throw error;
      }
      // PRS-07 resolveName: файл размещён под фактическим именем — версия
      // привязывается к фактическому пакету (заявленный-фантом удаляется).
      if (derived.name !== body.name) {
        db.delete(packages).where(eq(packages.name, body.name)).run();
        effectivePkg = ensurePackage(db, derived.name, body.repositories ?? [], now);
      }
      try {
        db.insert(versions)
          .values({
            packageName: derived.name,
            version: derived.version,
            sha256: sha256(file),
            createdAt: now,
          })
          .run();
      } catch (error) {
        // ATOM-01: компенсация — удалить записанное в фс.
        await removeArtifactFromRepos(db, pkg, derived.name, derived.version);
        throw error;
      }
    } else if (body.version !== undefined) {
      db.insert(versions)
        .values({
          packageName: body.name,
          version: body.version,
          sha256: "",
          createdAt: now,
        })
        .run();
    }

    logger.info("package created", { req_id: reqId, name: body.name });
    return c.json(buildPackageResponse(deps, effectivePkg), 201);
  });

  // ADD-03. Добавление версии.
  app.post("/:name/versions", async (c) => {
    const name = c.req.param("name");
    if (!nameSchema.safeParse(name).success) return c.json({ error: "invalid_request" }, 400);
    let body: z.infer<typeof versionBodySchema>;
    let file: Uint8Array | undefined;
    try {
      if (isJsonRequest(c)) {
        body = versionBodySchema.parse(await c.req.json());
        if (body.file !== undefined) file = Buffer.from(body.file, "utf8");
      } else {
        // PRS-07: файл — бинарное тело запроса; версия/флаги — в query.
        file = new Uint8Array(await c.req.arrayBuffer());
        body = versionBodySchema.parse({
          version: c.req.query("version") ?? "",
          resolveName: queryBool(c.req.query("resolveName")),
        });
      }
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    const pkg = getPackage(db, name);
    if (!pkg) return c.json({ error: "not_found" }, 404);
    if (file !== undefined && pkg.repositories.length === 0) {
      // MOV-06: файлу негде жить.
      return c.json({ error: "no_repositories" }, 400);
    }
    const dup = db
      .select()
      .from(versions)
      .where(and(eq(versions.packageName, name), eq(versions.version, body.version)))
      .get();
    if (dup) return c.json({ error: "version_exists" }, 409);

    const now = new Date();
    if (file !== undefined) {
      let derived;
      try {
        derived = await writeArtifactToRepos(
          db,
          pkg,
          name,
          body.version,
          file,
          adapter,
          body.resolveName === true,
        );
      } catch (error) {
        if (isArtifactError(error)) return artifactErrorResponse(c, error);
        throw error;
      }
      // PRS-07 resolveName: файл размещён под фактическим именем —
      // версия привязывается к фактическому пакету (создаётся при необходимости).
      const versionPkg =
        derived.name !== name ? ensurePackage(db, derived.name, [], now) : pkg;
      // ADD-03: дубль проверяется по фактической версии файла.
      const dupDerived = db
        .select()
        .from(versions)
        .where(and(eq(versions.packageName, derived.name), eq(versions.version, derived.version)))
        .get();
      if (dupDerived) {
        await removeArtifactFromRepos(db, pkg, derived.name, derived.version);
        return c.json({ error: "version_exists" }, 409);
      }
      db.insert(versions)
        .values({
          packageName: derived.name,
          version: derived.version,
          sha256: sha256(file),
          createdAt: now,
        })
        .run();
      return c.json(buildPackageResponse(deps, versionPkg), 201);
    } else {
      db.insert(versions)
        .values({
          packageName: name,
          version: body.version,
          sha256: "",
          createdAt: now,
        })
        .run();
    }
    return c.json(buildPackageResponse(deps, pkg), 201);
  });

  // PKG-01, UPD-02, GET одного пакета.
  app.get("/:name", (c) => {
    const name = c.req.param("name");
    const pkg = getPackage(db, name);
    if (!pkg) return c.json({ error: "not_found" }, 404);
    return c.json(buildPackageResponse(deps, pkg));
  });

  // UPD-02, ADD-05. Обновление полей пакета.
  app.put("/:name", async (c) => {
    const name = c.req.param("name");
    const pkg = getPackage(db, name);
    if (!pkg) return c.json({ error: "not_found" }, 404);
    let body: z.infer<typeof updateBodySchema>;
    try {
      body = updateBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    db.update(packages)
      .set({
        testUrl: body.testUrl ?? pkg.testUrl,
        buildUrl: body.buildUrl ?? pkg.buildUrl,
      })
      .where(eq(packages.name, name))
      .run();
    const updated = getPackage(db, name);
    return c.json(buildPackageResponse(deps, updated!));
  });

  // MOV-01..06. Размещение в репозиториях.
  app.patch("/:name", async (c) => {
    const name = c.req.param("name");
    const pkg = getPackage(db, name);
    if (!pkg) return c.json({ error: "not_found" }, 404);
    let body: z.infer<typeof repositoriesBodySchema>;
    try {
      body = repositoriesBodySchema.parse(await c.req.json());
    } catch {
      // MOV-02: пустой список репозиториев — ошибка.
      return c.json({ error: "invalid_request" }, 400);
    }
    // MOV-01: репозитории должны существовать; частичный сбой — ничего не применяем.
    for (const repoName of body.repositories) {
      if (!repositoryByIdentity(db, repoName)) {
        return c.json({ error: "repository_not_found", repository: repoName }, 400);
      }
    }
    db.update(packages)
      .set({ repositories: body.repositories })
      .where(eq(packages.name, name))
      .run();

    // MOV-04: файлы существующих версий попадают в каждый репозиторий из списка.
    const rowData = db
      .select()
      .from(versions)
      .where(eq(versions.packageName, name))
      .all();
    const fresh = getPackage(db, name)!;
    for (const row of rowData) {
      try {
        const content = await (async () => {
          for (const repo of reposOf(db, fresh)) {
            const target = join(repo.path, artifactFileName(name, row.version, repo.type));
            try {
              return await import("node:fs/promises").then((m) => m.readFile(target));
            } catch {
              // not in this repo
            }
          }
          return undefined;
        })();
        if (content === undefined) continue;
        await writeFileToRepos(db, fresh, name, row.version, content, adapter);
      } catch {
        // не блокирует размещение
      }
    }
    const updated = getPackage(db, name);
    return c.json(buildPackageResponse(deps, updated!));
  });

  // DEL-01. Удаление пакета целиком.
  app.delete("/:name", async (c) => {
    const name = c.req.param("name");
    const pkg = getPackage(db, name);
    if (!pkg) return c.json({ error: "not_found" }, 404);
    const rows = db.select().from(versions).where(eq(versions.packageName, name)).all();
    for (const row of rows) {
      await removeArtifactFromRepos(db, pkg, name, row.version);
    }
    db.delete(packages).where(eq(packages.name, name)).run();
    return c.body(null, 204);
  });

  // UPD-01..05. Обновление версии.
  app.put("/:name/versions/:version", async (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    if (!nameSchema.safeParse(name).success || !versionSchema.safeParse(version).success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    let body: z.infer<typeof versionUpdateBodySchema>;
    let file: Uint8Array | undefined;
    try {
      if (isJsonRequest(c)) {
        body = versionUpdateBodySchema.parse(await c.req.json());
        if (body.file !== undefined) file = Buffer.from(body.file, "utf8");
      } else {
        // PRS-07: файл — бинарное тело запроса; resolveName — в query.
        file = new Uint8Array(await c.req.arrayBuffer());
        body = versionUpdateBodySchema.parse({
          resolveName: queryBool(c.req.query("resolveName")),
        });
      }
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    const pkg = getPackage(db, name);
    if (!pkg) {
      // UPD-03: пакет не объявлен — ленивое обновление индекса по файлу в репозиториях.
      const repos = db.select().from(repositories).all();
      let found = false;
      for (const repo of repos) {
        const target = join(repo.path, artifactFileName(name, version, repo.type));
        try {
          await access(target, fsConstants.F_OK);
          found = true;
          break;
        } catch {
          // не здесь
        }
      }
      if (!found) return c.json({ error: "not_found" }, 404);
      const now = new Date();
      db.insert(packages)
        .values({
          name,
          testUrl: null,
          buildUrl: null,
          repositories: [],
          createdAt: now,
        })
        .run();
      db.insert(versions)
        .values({
          packageName: name,
          version,
          sha256: file !== undefined ? sha256(file) : "",
          createdAt: now,
        })
        .run();
      const created = getPackage(db, name);
      return c.json(buildPackageResponse(deps, created!));
    }

    const row = db
      .select()
      .from(versions)
      .where(and(eq(versions.packageName, name), eq(versions.version, version)))
      .get();

    if (!row) {
      // UPD-03: ленивое обновление индекса — поиск файла в репозиториях.
      if (!(await artifactExistsInRepos(db, pkg, name, version))) {
        return c.json({ error: "not_found" }, 404);
      }
      const now = new Date();
      db.insert(versions)
        .values({
          packageName: name,
          version,
          sha256: file !== undefined ? sha256(file) : "",
          createdAt: now,
        })
        .run();
      if (file !== undefined) {
        await writeFileToRepos(db, pkg, name, version, file, adapter);
      }
      return c.json(buildPackageResponse(deps, pkg));
    }

    if (file === undefined) {
      // Нет файла — обновляем только поля (UPD-02). Других полей нет.
      return c.json(buildPackageResponse(deps, pkg));
    }

    const newHash = sha256(file);
    // UPD-04: полное совпадение параметров — ошибка.
    if (row.sha256 === newHash) {
      return c.json({ error: "no_changes" }, 409);
    }
    // UPD-01: перезапись при разной хэшсумме — варнинг.
    let derived;
    try {
      derived = await writeArtifactToRepos(
        db,
        pkg,
        name,
        version,
        file,
        adapter,
        body.resolveName === true,
      );
    } catch (error) {
      if (isArtifactError(error)) return artifactErrorResponse(c, error);
      throw error;
    }
    if (derived.version !== version) {
      // PRS-07: версия файла не соответствует перезаписываемой. Без resolveName —
      // ошибка с фактической (ожидаемой) версией; с resolveName — файл переименован
      // сервером под фактическое имя/версию, запись переводится на них.
      if (body.resolveName !== true) {
        return artifactErrorResponse(
          c,
          new ArtifactError("artifact_version_mismatch", derived),
        );
      }
      if (derived.name !== name) {
        ensurePackage(db, derived.name, [], new Date());
      }
      const dup = db
        .select()
        .from(versions)
        .where(and(eq(versions.packageName, derived.name), eq(versions.version, derived.version)))
        .get();
      if (dup) {
        await removeArtifactFromRepos(db, pkg, derived.name, derived.version);
        return c.json({ error: "version_exists" }, 409);
      }
      db.delete(versions)
        .where(and(eq(versions.packageName, name), eq(versions.version, version)))
        .run();
      db.insert(versions)
        .values({
          packageName: derived.name,
          version: derived.version,
          sha256: newHash,
          createdAt: row.createdAt,
        })
        .run();
      return c.json({ warning: true, name: derived.name, version: derived.version });
    }
    db.update(versions)
      .set({ sha256: newHash })
      .where(and(eq(versions.packageName, name), eq(versions.version, version)))
      .run();
    return c.json({ warning: true });
  });

  // DEL версии: удаляется файл/ссылки из репозиториев, запись версии и журналы этой версии.
  app.delete("/:name/versions/:version", async (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    if (!nameSchema.safeParse(name).success || !versionSchema.safeParse(version).success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const pkg = getPackage(db, name);
    if (!pkg) return c.json({ error: "not_found" }, 404);
    const row = db
      .select()
      .from(versions)
      .where(and(eq(versions.packageName, name), eq(versions.version, version)))
      .get();
    if (!row) return c.json({ error: "not_found" }, 404);

    // Атомарность: сначала фс (удаление файлов/ссылок), затем бд.
    await removeArtifactFromRepos(db, pkg, name, version);
    db.delete(versions)
      .where(and(eq(versions.packageName, name), eq(versions.version, version)))
      .run();
    db.delete(testJournal)
      .where(and(eq(testJournal.packageName, name), eq(testJournal.version, version)))
      .run();
    db.delete(buildJournal)
      .where(and(eq(buildJournal.packageName, name), eq(buildJournal.version, version)))
      .run();
    return c.body(null, 204);
  });

  // TST-01: фантом нельзя тестировать.
  app.post("/:name/test", async (c) => {
    const name = c.req.param("name");
    const pkg = getPackage(db, name);
    if (!pkg) return c.json({ error: "not_found" }, 404);
    const rows = db.select().from(versions).where(eq(versions.packageName, name)).all();
    if (rows.length === 0) return c.json({ error: "phantom" }, 400);
    const last = rows[rows.length - 1]!;
    return startTest(c, deps, orch, name, last.version);
  });

  // TST-02..07. Запуск тестирования версии.
  app.post("/:name/versions/:version/test", async (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    const pkg = getPackage(db, name);
    if (!pkg) return c.json({ error: "not_found" }, 404);
    const row = db
      .select()
      .from(versions)
      .where(and(eq(versions.packageName, name), eq(versions.version, version)))
      .get();
    if (!row) return c.json({ error: "not_found" }, 404);
    return startTest(c, deps, orch, name, version);
  });

  // TST-03/CBK-01: колбэк теста.
  app.post("/:name/versions/:version/test/:id/callback", async (c) => {
    const id = c.req.param("id");
    const row = db.select().from(testJournal).where(eq(testJournal.id, id)).get();
    if (!row) {
      // CBK-03: неизвестный id — игнорируем, предупреждение в лог.
      logger.warn("callback for unknown id", { req_id: c.get("reqId"), id });
      return c.json({ error: "not_found" }, 404);
    }
    if (row.status !== "running") {
      // CBK-02: повторный колбэк — игнорируется.
      return c.json({ ok: true });
    }
    // CBK-01: результат из переменной url колбэка ({result}) или из JSON body.
    const raw = await c.req.text();
    const queryResult = c.req.query("result");
    let jsonResult: string | undefined;
    if (raw.trim() !== "") {
      try {
        const parsed = JSON.parse(raw) as { result?: string };
        jsonResult = parsed.result;
      } catch {
        // body — plain text, не обрабатываем
      }
    }
    const result = queryResult ?? jsonResult;
    if (result !== "ok" && result !== "fail") {
      return c.json({ error: "invalid_result" }, 400);
    }
    db.update(testJournal)
      .set({ status: result, body: raw })
      .where(eq(testJournal.id, id))
      .run();
    return c.json({ ok: true });
  });

  // TST-04: пометить запись теста недействительной.
  app.post("/:name/versions/:version/test/:id/invalidate", (c) => {
    const id = c.req.param("id");
    const row = db.select().from(testJournal).where(eq(testJournal.id, id)).get();
    if (!row) return c.json({ error: "not_found" }, 404);
    db.update(testJournal).set({ invalid: true }).where(eq(testJournal.id, id)).run();
    return c.json({ ok: true });
  });

  // Журнал теста.
  app.get("/:name/versions/:version/test/log", (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    const entries = db
      .select()
      .from(testJournal)
      .where(and(eq(testJournal.packageName, name), eq(testJournal.version, version)))
      .all()
      .map((row) => ({ id: row.id, status: row.status, body: row.body ?? undefined }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return c.json({ entries });
  });

  // BLD-01: сборка пакета (может быть фантом с any).
  app.post("/:name/build", async (c) => {
    const name = c.req.param("name");
    let body: z.infer<typeof runBodySchema>;
    try {
      body = runBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    const version = body.version ?? "any";
    return startBuild(c, deps, orch, name, version);
  });

  // Сборка конкретной версии.
  app.post("/:name/versions/:version/build", async (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    return startBuild(c, deps, orch, name, version);
  });

  // BLD-02/03, CBK-01: колбэк сборки.
  app.post("/:name/build/:id/callback", async (c) => {
    const id = c.req.param("id");
    const raw = await c.req.text();
    const queryResult = c.req.query("result");
    const queryVersion = c.req.query("version");
    let jsonResult: string | undefined;
    let jsonVersion: string | undefined;
    if (raw.trim() !== "") {
      try {
        const parsed = JSON.parse(raw) as { result?: string; version?: string };
        jsonResult = parsed.result;
        jsonVersion = parsed.version;
      } catch {
        // body — plain text, не обрабатываем
      }
    }
    const result = queryResult ?? jsonResult;
    if (result !== "ok" && result !== "fail") {
      return c.json({ error: "invalid_result" }, 400);
    }
    const version = queryVersion ?? jsonVersion;
    if (version === undefined) return c.json({ error: "invalid_request" }, 400);
    // BLD-02: раннер обязан дать конкретную версию.
    if (version === "any") return c.json({ error: "version_required" }, 400);

    const row = db.select().from(buildJournal).where(eq(buildJournal.id, id)).get();
    if (!row) {
      logger.warn("callback for unknown id", { req_id: c.get("reqId"), id });
      return c.json({ error: "not_found" }, 404);
    }
    if (row.status !== "running") {
      return c.json({ ok: true });
    }

    db.update(buildJournal)
      .set({ status: result, resultVersion: version, body: raw })
      .where(eq(buildJournal.id, id))
      .run();

    // Версия из результата появляется у пакета.
    const existing = db
      .select()
      .from(versions)
      .where(
        and(
          eq(versions.packageName, row.packageName),
          eq(versions.version, version),
        ),
      )
      .get();
    if (!existing) {
      db.insert(versions)
        .values({
          packageName: row.packageName,
          version,
          sha256: "",
          createdAt: new Date(),
        })
        .run();
    }
    return c.json({ ok: true });
  });

  // BLD-04: пометить запись сборки недействительной.
  app.post("/:name/build/:id/invalidate", (c) => {
    const id = c.req.param("id");
    const row = db.select().from(buildJournal).where(eq(buildJournal.id, id)).get();
    if (!row) return c.json({ error: "not_found" }, 404);
    db.update(buildJournal).set({ invalid: true }).where(eq(buildJournal.id, id)).run();
    return c.json({ ok: true });
  });

  // Журнал сборки.
  app.get("/:name/versions/:version/build/log", (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    const entries = db
      .select()
      .from(buildJournal)
      .where(and(eq(buildJournal.packageName, name), eq(buildJournal.version, version)))
      .all()
      .map((row) => ({ id: row.id, status: row.status, body: row.body ?? undefined }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return c.json({ entries });
  });

  return app;
}