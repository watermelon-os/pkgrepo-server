import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Hono, type Context } from "hono";
import { packages, repositories, specs, versions } from "../db/schema.js";
import { createLogger } from "../logger.js";
import type { PackageApiDeps } from "./packages/deps.js";
import { resolveAdapter } from "./packages/deps.js";
import {
  createBodySchema,
  nameSchema,
  repositoriesBodySchema,
  versionBodySchema,
  versionSchema,
  versionUpdateBodySchema,
} from "./packages/schemas.js";
import {
  artifactExistsInRepos,
  ArtifactError,
  artifactFileName,
  getPackage,
  parseUpload,
  removeArtifactFromRepos,
  repositoryByIdentity,
  reposOf,
  sha256,
  writeFileToRepos,
} from "./packages/artifacts.js";
import { buildPackageResponse } from "./packages/response.js";
import { runSync } from "./packages/sync.js";

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`.*${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}.*`);
}

// PRS-07: бинарная загрузка — файл в теле запроса, метаданные (name/version/
// repositories) — в query. Детекция: тело считается бинарным для любого
// content-type, кроме явного application/json (Rext может не ставить
// octet-stream для @body).
function isJsonRequest(c: Context): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
}

function queryRepositories(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const list = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return list.length === 0 ? undefined : list;
}

function queryBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === "true" || v === "1";
}

/** Ответ для ошибок размещения: код + фактические имя/версия из метаданных. */
function artifactErrorResponse(c: Context, error: ArtifactError) {
  return c.json(
    error.derived
      ? { error: error.code, name: error.derived.name, version: error.derived.version }
      : { error: error.code },
    400,
  );
}

/** Привязка артефакта к спеку: спек должен существовать у имени. */
function resolveSpecId(
  db: PackageApiDeps["db"],
  name: string,
  specVersion: string | undefined,
): number | undefined | "not_found" {
  if (specVersion === undefined) return undefined;
  const spec = db
    .select()
    .from(specs)
    .where(and(eq(specs.name, name), eq(specs.version, specVersion)))
    .get();
  return spec ? spec.id : "not_found";
}

export function packageRoutes(deps: PackageApiDeps): Hono {
  const db = deps.db;
  const logger = deps.logger ?? createLogger({ level: "info" });
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
      return true;
    });

    return c.json({
      packages: filtered.map((pkg) => buildPackageResponse(deps, pkg)),
    });
  });

  // ADD-01/NM-02. Создание имени загрузкой пакета: имя и версия разбираются
  // из самого артефакта (утилита → парсер имени файла), в запросе не задаются.
  app.post("/", async (c) => {
    const reqId = c.get("reqId");
    let body: z.infer<typeof createBodySchema>;
    let file: Uint8Array | undefined;
    try {
      if (isJsonRequest(c)) {
        body = createBodySchema.parse(await c.req.json());
        if (body.file !== undefined) file = Buffer.from(body.file, "utf8");
      } else {
        // PRS-06: файл — бинарное тело запроса; метаданные — в query.
        const bytes = await c.req.arrayBuffer();
        file = bytes.byteLength > 0 ? new Uint8Array(bytes) : undefined;
        body = createBodySchema.parse({
          filename: c.req.query("filename") ?? undefined,
          repositories: queryRepositories(c.req.query("repositories")),
          specVersion: c.req.query("specVersion") ?? undefined,
          override: queryBool(c.req.query("override")),
        });
      }
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    // override принимаем и в теле (JSON), и в query — для единообразия с бинарной загрузкой.
    if (body.override === undefined) body.override = queryBool(c.req.query("override"));
    if (file === undefined) {
      // Фантомов больше нет: имя создается только загрузкой файла.
      return c.json({ error: "file_required" }, 400);
    }
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
    // Разбор до записи в фс и бд (Атомарность): ошибка не оставляет следов.
    const derived = await parseUpload(adapter, file, body.filename);
    if (!derived) {
      return artifactErrorResponse(c, new ArtifactError("artifact_unparseable"));
    }
    // Имя — только объединение версий: если имя уже есть (например, создано
    // спеком), просто добавляем в него версию. Уникальность — у версии
    // (имя+версия+хэш), а не у имени.
    const now = new Date();
    let pkg = getPackage(db, derived.name);
    if (!pkg) {
      db.insert(packages)
        .values({
          name: derived.name,
          repositories: body.repositories ?? [],
          createdAt: now,
        })
        .run();
      pkg = getPackage(db, derived.name)!;
    } else {
      // MOV-06: репозитории из запроса добавляются к существующему списку.
      const merged = [...new Set([...pkg.repositories, ...(body.repositories ?? [])])];
      if (merged.length !== pkg.repositories.length) {
        db.update(packages)
          .set({ repositories: merged })
          .where(eq(packages.name, derived.name))
          .run();
        pkg = getPackage(db, derived.name)!;
      }
    }

    // Уникальность версии: имя+версия; без override дубль — ошибка (NM-04).
    const dup = db
      .select()
      .from(versions)
      .where(and(eq(versions.packageName, derived.name), eq(versions.version, derived.version)))
      .get();
    if (dup && body.override !== true) {
      const sameHash = dup.sha256 === sha256(file);
      logger.warn(sameHash ? "package upload: no changes" : "version upload rejected: version exists", {
        req_id: reqId,
        name: derived.name,
        version: derived.version,
        sha256: dup.sha256,
      });
      return c.json({ error: sameHash ? "no_changes" : "version_exists" }, 409);
    }

    const specId = resolveSpecId(db, derived.name, body.specVersion);
    if (specId === "not_found") {
      return c.json({ error: "spec_not_found", specVersion: body.specVersion }, 400);
    }
    await writeFileToRepos(db, pkg, derived.name, derived.version, file, adapter);
    try {
      if (dup) {
        // NM-04 override: перезапись «втупую», хэш пересчитывается.
        db.update(versions)
          .set({ sha256: sha256(file), specId })
          .where(and(eq(versions.packageName, derived.name), eq(versions.version, derived.version)))
          .run();
        logger.info("package version overridden", {
          req_id: reqId,
          name: derived.name,
          version: derived.version,
        });
        return c.json(buildPackageResponse(deps, pkg));
      }
      db.insert(versions)
        .values({
          packageName: derived.name,
          version: derived.version,
          sha256: sha256(file),
          specId,
          createdAt: now,
        })
        .run();
    } catch (error) {
      // ATOM-01: компенсация — удалить записанное в фс.
      await removeArtifactFromRepos(db, pkg, derived.name, derived.version);
      throw error;
    }

    logger.info("package created", { req_id: reqId, name: derived.name });
    return c.json(buildPackageResponse(deps, pkg), 201);
  });

  // Добавление версии к существующему имени (имя адресуется путем, версия
  // разбирается из файла).
  app.post("/:name/versions", async (c) => {
    const reqId = c.get("reqId");
    const name = c.req.param("name");
    if (!nameSchema.safeParse(name).success) return c.json({ error: "invalid_request" }, 400);
    let body: z.infer<typeof versionBodySchema>;
    let file: Uint8Array | undefined;
    try {
      if (isJsonRequest(c)) {
        body = versionBodySchema.parse(await c.req.json());
        if (body.file !== undefined) file = Buffer.from(body.file, "utf8");
      } else {
        // PRS-06: файл — бинарное тело запроса; параметры — в query.
        const bytes = await c.req.arrayBuffer();
        file = bytes.byteLength > 0 ? new Uint8Array(bytes) : undefined;
        body = versionBodySchema.parse({
          filename: c.req.query("filename") ?? undefined,
          specVersion: c.req.query("specVersion") ?? undefined,
          override: queryBool(c.req.query("override")),
        });
      }
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    // override принимаем и в теле (JSON), и в query — для единообразия с бинарной загрузкой.
    if (body.override === undefined) body.override = queryBool(c.req.query("override"));
    if (file === undefined) {
      // Версия появляется только из файла-артефакта.
      return c.json({ error: "file_required" }, 400);
    }
    const pkg = getPackage(db, name);
    if (!pkg) return c.json({ error: "not_found" }, 404);
    if (pkg.repositories.length === 0) {
      // MOV-06: файлу негде жить.
      return c.json({ error: "no_repositories" }, 400);
    }
    const derived = await parseUpload(adapter, file, body.filename);
    if (!derived) {
      return artifactErrorResponse(c, new ArtifactError("artifact_unparseable"));
    }
    if (derived.name !== name) {
      return artifactErrorResponse(c, new ArtifactError("artifact_name_mismatch", derived));
    }
    const dup = db
      .select()
      .from(versions)
      .where(and(eq(versions.packageName, name), eq(versions.version, derived.version)))
      .get();
    if (dup && body.override !== true) {
      const sameHash = dup.sha256 === sha256(file);
      logger.warn(sameHash ? "version upload: no changes" : "version upload rejected: version exists", {
        req_id: reqId,
        name,
        version: derived.version,
        sha256: dup.sha256,
      });
      return c.json({ error: sameHash ? "no_changes" : "version_exists" }, 409);
    }

    const specId = resolveSpecId(db, name, body.specVersion);
    if (specId === "not_found") {
      return c.json({ error: "spec_not_found", specVersion: body.specVersion }, 400);
    }
    const now = new Date();
    await writeFileToRepos(db, pkg, name, derived.version, file, adapter);
    try {
      if (dup) {
        // NM-04 override: перезапись «втупую», хэш пересчитывается.
        db.update(versions)
          .set({ sha256: sha256(file), specId })
          .where(and(eq(versions.packageName, name), eq(versions.version, derived.version)))
          .run();
        logger.info("package version overridden", {
          req_id: reqId,
          name,
          version: derived.version,
        });
        return c.json(buildPackageResponse(deps, pkg));
      }
      db.insert(versions)
        .values({
          packageName: name,
          version: derived.version,
          sha256: sha256(file),
          specId,
          createdAt: now,
        })
        .run();
    } catch (error) {
      // ATOM-01/ATOM-02: компенсация — удалить записанное в фс.
      await removeArtifactFromRepos(db, pkg, name, derived.version);
      throw error;
    }
    return c.json(buildPackageResponse(deps, pkg), 201);
  });

  // PKG-01, GET одного пакета.
  app.get("/:name", (c) => {
    const name = c.req.param("name");
    const pkg = getPackage(db, name);
    if (!pkg) return c.json({ error: "not_found" }, 404);
    return c.json(buildPackageResponse(deps, pkg));
  });

  // Спек, которым собран артефакт (по имени, версии и релизу внутри version-строки).
  app.get("/:name/versions/:version/spec", (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    const row = db
      .select({ spec: specs })
      .from(versions)
      .innerJoin(specs, eq(versions.specId, specs.id))
      .where(and(eq(versions.packageName, name), eq(versions.version, version)))
      .get();
    if (!row) return c.json({ error: "not_found" }, 404);
    c.header("content-type", "text/plain; charset=utf-8");
    c.header(
      "content-disposition",
      `attachment; filename="${name}-${row.spec.version}.spec"`,
    );
    return c.body(row.spec.content);
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

  // UPD-01..04. Обновление версии.
  app.put("/:name/versions/:version", async (c) => {
    const reqId = c.get("reqId");
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
        // PRS-06: файл — бинарное тело запроса; параметры — в query.
        const bytes = await c.req.arrayBuffer();
        file = bytes.byteLength > 0 ? new Uint8Array(bytes) : undefined;
        body = versionUpdateBodySchema.parse({
          filename: c.req.query("filename") ?? undefined,
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
      return c.json(buildPackageResponse(deps, pkg));
    }

    const newHash = sha256(file);
    // UPD-02: полное совпадение параметров — ошибка.
    if (row.sha256 === newHash) {
      logger.warn("version update rejected: no changes", {
        req_id: reqId,
        name,
        version,
      });
      return c.json({ error: "no_changes" }, 409);
    }
    // UPD-01: перезапись при разной хэшсумме — варнинг. Имя/версия файла
    // обязаны совпасть с адресом (PRS-07): расхождение — ошибка до записи в фс.
    const derived = await parseUpload(adapter, file, body.filename);
    if (!derived) {
      return artifactErrorResponse(c, new ArtifactError("artifact_unparseable"));
    }
    if (derived.name !== name) {
      return artifactErrorResponse(c, new ArtifactError("artifact_name_mismatch", derived));
    }
    if (derived.version !== version) {
      return artifactErrorResponse(c, new ArtifactError("artifact_version_mismatch", derived));
    }
    await writeFileToRepos(db, pkg, name, version, file, adapter);
    db.update(versions)
      .set({ sha256: newHash })
      .where(and(eq(versions.packageName, name), eq(versions.version, version)))
      .run();
    return c.json({ warning: true });
  });

  // DEL версии: удаляется файл/ссылки из репозиториев и запись версии.
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
    return c.body(null, 204);
  });

  return app;
}
