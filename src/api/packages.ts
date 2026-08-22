import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Hono, type Context } from "hono";
import { packages, repositories, versions } from "../db/schema.js";
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
  isArtifactError,
  removeArtifactFromRepos,
  repositoryByIdentity,
  reposOf,
  sha256,
  writeArtifactToRepos,
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

/** Ответ для ошибок размещения: код + фактические имя/версия из метаданных. */
function artifactErrorResponse(c: Context, error: ArtifactError) {
  return c.json(
    error.derived
      ? { error: error.code, name: error.derived.name, version: error.derived.version }
      : { error: error.code },
    400,
  );
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

  // ADD-01. Создание пакета сразу с первой версией (файл обязателен, фантомов нет).
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
        const bytes = await c.req.arrayBuffer();
        file = bytes.byteLength > 0 ? new Uint8Array(bytes) : undefined;
        body = createBodySchema.parse({
          name: c.req.query("name") ?? "",
          version: c.req.query("version") ?? undefined,
          repositories: queryRepositories(c.req.query("repositories")),
        });
      }
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (file === undefined) {
      // Фантомов больше нет: имя создается только загрузкой файла.
      return c.json({ error: "file_required" }, 400);
    }
    const existing = getPackage(db, body.name);
    if (existing) {
      return c.json({ error: "package_exists" }, 409);
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
    const now = new Date();
    db.insert(packages)
      .values({
        name: body.name,
        repositories: body.repositories ?? [],
        createdAt: now,
      })
      .run();

    const pkg = getPackage(db, body.name)!;
    let derived;
    try {
      // Первая загрузка имени: версия берется из метаданных файла.
      derived = await writeArtifactToRepos(db, pkg, body.name, body.version ?? "", file, adapter, {
        deriveVersion: true,
      });
    } catch (error) {
      if (isArtifactError(error)) return artifactErrorResponse(c, error);
      throw error;
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

    logger.info("package created", { req_id: reqId, name: body.name });
    return c.json(buildPackageResponse(deps, pkg), 201);
  });

  // Добавление версии к существующему имени.
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
        // PRS-07: файл — бинарное тело запроса; версия — в query.
        const bytes = await c.req.arrayBuffer();
        file = bytes.byteLength > 0 ? new Uint8Array(bytes) : undefined;
        body = versionBodySchema.parse({
          version: c.req.query("version") ?? "",
        });
      }
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
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
    const dup = db
      .select()
      .from(versions)
      .where(and(eq(versions.packageName, name), eq(versions.version, body.version)))
      .get();
    if (dup) return c.json({ error: "version_exists" }, 409);

    const now = new Date();
    let derived;
    try {
      derived = await writeArtifactToRepos(db, pkg, name, body.version, file, adapter);
    } catch (error) {
      if (isArtifactError(error)) return artifactErrorResponse(c, error);
      throw error;
    }
    db.insert(versions)
      .values({
        packageName: derived.name,
        version: derived.version,
        sha256: sha256(file),
        createdAt: now,
      })
      .run();
    return c.json(buildPackageResponse(deps, pkg), 201);
  });

  // PKG-01, GET одного пакета.
  app.get("/:name", (c) => {
    const name = c.req.param("name");
    const pkg = getPackage(db, name);
    if (!pkg) return c.json({ error: "not_found" }, 404);
    return c.json(buildPackageResponse(deps, pkg));
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
        // PRS-07: файл — бинарное тело запроса.
        const bytes = await c.req.arrayBuffer();
        file = bytes.byteLength > 0 ? new Uint8Array(bytes) : undefined;
        body = versionUpdateBodySchema.parse({});
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
      return c.json({ error: "no_changes" }, 409);
    }
    // UPD-01: перезапись при разной хэшсумме — варнинг.
    // Расхождение версии файла с объявленной — ошибка до записи в фс (PRS-08).
    try {
      await writeArtifactToRepos(db, pkg, name, version, file, adapter);
    } catch (error) {
      if (isArtifactError(error)) return artifactErrorResponse(c, error);
      throw error;
    }
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
