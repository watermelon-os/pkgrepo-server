import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Hono, type Context } from "hono";
import type { OrchClient, Token } from "../app.js";
import type { DatabaseClient } from "../db/index.js";
import {
  buildJournal,
  packages,
  repositories,
  testJournal,
  versions,
} from "../db/schema.js";
import { createLogger, type Logger } from "../logger.js";

export interface RepoAdapter {
  isInitialized?: (dir: string, type: string) => boolean;
  update: (name: string, version?: string) => void | Promise<void>;
}

export interface PackageApiDeps {
  db: DatabaseClient;
  fsRoot?: string;
  commonTestUrl?: string;
  commonBuildUrl?: string;
  orch?: OrchClient;
  logger?: Logger;
  tokens?: Token[];
  repoAdapter?: RepoAdapter;
}

const nameSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._+~-]+$/);
const versionSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._+~-]+$/);

const createBodySchema = z.object({
  name: nameSchema,
  version: versionSchema.optional(),
  file: z.string().optional(),
  testUrl: z.string().url().optional(),
  buildUrl: z.string().url().optional(),
  repositories: z.array(z.string().min(1)).optional(),
});

const updateBodySchema = z.object({
  testUrl: z.string().url().optional(),
  buildUrl: z.string().url().optional(),
});

const versionBodySchema = z.object({
  version: versionSchema,
  file: z.string().optional(),
});

const versionUpdateBodySchema = z.object({
  file: z.string().optional(),
});

const repositoriesBodySchema = z.object({
  repositories: z.array(z.string().min(1)).min(1),
});

const runBodySchema = z.object({
  testUrl: z.string().url().optional(),
  buildUrl: z.string().url().optional(),
  version: versionSchema.optional(),
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function artifactFileName(name: string, version: string, type: string): string {
  const ext = type === "deb" ? "deb" : "rpm";
  return `${name}-${version}.${ext}`;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`.*${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}.*`);
}

/** Разбор имени файла по шаблону `{name}-{version}.{ext}`: версия — сегмент после последнего `-`. */
function parseArtifactName(
  fileName: string,
  type: string,
): { name: string; version: string } | undefined {
  const ext = `.${type === "deb" ? "deb" : "rpm"}`;
  if (!fileName.endsWith(ext)) return undefined;
  const base = fileName.slice(0, -ext.length);
  const idx = base.lastIndexOf("-");
  if (idx <= 0) return undefined;
  const name = base.slice(0, idx);
  const version = base.slice(idx + 1);
  if (!nameSchema.safeParse(name).success || !versionSchema.safeParse(version).success) {
    return undefined;
  }
  return { name, version };
}

function repositoryByIdentity(db: DatabaseClient, name: string) {
  return db.select().from(repositories).where(eq(repositories.name, name)).get();
}

function reposOf(
  db: DatabaseClient,
  pkg: { repositories: string[] },
): Array<{ name: string; path: string; type: string }> {
  return pkg.repositories
    .map((name) => repositoryByIdentity(db, name))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
}

/** Запись файла во временный файл + атомарный rename внутри каждого репозитория пакета. */
async function writeArtifactToRepos(
  db: DatabaseClient,
  pkg: { repositories: string[] },
  name: string,
  version: string,
  content: string,
  adapter?: RepoAdapter,
): Promise<void> {
  for (const repo of reposOf(db, pkg)) {
    const target = join(repo.path, artifactFileName(name, version, repo.type));
    await mkdir(repo.path, { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content);
    await rename(tmp, target);
    if (adapter) {
      await adapter.update(name, version);
    }
  }
}

async function removeArtifactFromRepos(
  db: DatabaseClient,
  pkg: { repositories: string[] },
  name: string,
  version: string,
): Promise<void> {
  for (const repo of reposOf(db, pkg)) {
    try {
      await rm(join(repo.path, artifactFileName(name, version, repo.type)), { force: true });
    } catch {
      // File not present — nothing to remove.
    }
  }
}

/** Наличие файла в одном из репозиториев пакета (для ленивого индекса). */
async function artifactExistsInRepos(
  db: DatabaseClient,
  pkg: { repositories: string[] },
  name: string,
  version: string,
): Promise<boolean> {
  for (const repo of reposOf(db, pkg)) {
    try {
      await access(join(repo.path, artifactFileName(name, version, repo.type)), fsConstants.F_OK);
      return true;
    } catch {
      // not in this repo
    }
  }
  return false;
}

export interface VersionStatus {
  version: string;
  repositories: string[];
  testStatus?: string;
  buildStatus?: string;
}

function journalStatus(
  db: DatabaseClient,
  table: typeof testJournal | typeof buildJournal,
  packageName: string,
  version: string,
): string | undefined {
  const rows = db
    .select()
    .from(table)
    .where(and(eq(table.packageName, packageName), eq(table.version, version)))
    .all()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (!row.invalid && (row.status === "ok" || row.status === "fail")) {
      return row.status;
    }
  }
  return undefined;
}

function buildStatusForVersion(
  db: DatabaseClient,
  packageName: string,
  version: string,
): string | undefined {
  const rows = db
    .select()
    .from(buildJournal)
    .where(eq(buildJournal.packageName, packageName))
    .all()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.invalid) continue;
    if (row.resultVersion !== null && row.resultVersion !== version) continue;
    if (row.resultVersion === null && row.version !== version) continue;
    if (row.status === "ok" || row.status === "fail") {
      return row.status;
    }
  }
  return undefined;
}

interface PackageRow {
  name: string;
  testUrl: string | null;
  buildUrl: string | null;
  repositories: string[];
}

function buildPackageResponse(
  deps: PackageApiDeps,
  pkg: PackageRow,
): {
  name: string;
  versions: VersionStatus[];
  testUrl?: string;
  buildUrl?: string;
  repositories: string[];
} {
  const db = deps.db;
  const versionRows = db
    .select()
    .from(versions)
    .where(eq(versions.packageName, pkg.name))
    .all()
    .sort((a, b) => a.version.localeCompare(b.version));
  const list: VersionStatus[] = versionRows.map((row) => ({
    version: row.version,
    repositories: pkg.repositories,
    testStatus: journalStatus(db, testJournal, pkg.name, row.version),
    buildStatus: buildStatusForVersion(db, pkg.name, row.version),
  }));
  return {
    name: pkg.name,
    versions: list,
    ...(pkg.testUrl ? { testUrl: pkg.testUrl } : {}),
    ...(pkg.buildUrl ? { buildUrl: pkg.buildUrl } : {}),
    repositories: pkg.repositories,
  };
}

export function packageRoutes(deps: PackageApiDeps): Hono {
  const db = deps.db;
  const logger = deps.logger ?? createLogger({ level: "info" });
  const orch: OrchClient =
    deps.orch ?? { start: async () => ({ ok: true, error: undefined, response: undefined }) };
  const adapter = deps.repoAdapter;

  const app = new Hono();

  // SYNC: ручной запуск синхронизации с фс (SVR-03).
  app.post("/sync", async (c) => {
    const reqId = c.get("reqId");
    const repos = db.select().from(repositories).all();
    let picked = 0;
    for (const repo of repos) {
      let files: string[] = [];
      try {
        files = await readdir(repo.path);
      } catch {
        logger.warn("sync: cannot read repository", { req_id: reqId, repo: repo.name });
        continue;
      }
      for (const file of files) {
        const parsed = parseArtifactName(file, repo.type);
        if (!parsed) continue; // неразбираемое имя — только пропускаем
        const { name, version } = parsed;
        let pkg = db.select().from(packages).where(eq(packages.name, name)).get();
        if (!pkg) {
          db.insert(packages)
            .values({
              name,
              testUrl: null,
              buildUrl: null,
              repositories: [repo.name],
              createdAt: new Date(),
            })
            .run();
          pkg = db.select().from(packages).where(eq(packages.name, name)).get()!;
        } else if (!pkg.repositories.includes(repo.name)) {
          db.update(packages)
            .set({ repositories: [...pkg.repositories, repo.name] })
            .where(eq(packages.name, name))
            .run();
        }
        const existing = db
          .select()
          .from(versions)
          .where(and(eq(versions.packageName, name), eq(versions.version, version)))
          .get();
        if (existing) continue; // идемпотентность
        const target = join(repo.path, artifactFileName(name, version, repo.type));
        let content = "";
        try {
          content = await import("node:fs/promises").then((m) => m.readFile(target, "utf8"));
        } catch {
          logger.warn("sync: cannot read artifact", { req_id: reqId, repo: repo.name, file });
          continue;
        }
        db.insert(versions)
          .values({
            packageName: name,
            version,
            sha256: sha256(content),
            createdAt: new Date(),
          })
          .run();
        if (adapter) await adapter.update(name, version);
        picked += 1;
        logger.info("sync: picked artifact", { req_id: reqId, name, version, repo: repo.name });
      }
    }
    logger.info("sync done", { req_id: reqId, picked });
    return c.json({ ok: true, picked });
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
    try {
      body = createBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    const existing = db.select().from(packages).where(eq(packages.name, body.name)).get();
    if (existing) {
      // ADD-04: фантом при существующем пакете — ошибка.
      return c.json({ error: "package_exists" }, 409);
    }
    if (body.file !== undefined) {
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

    if (body.version !== undefined) {
      const pkg = db.select().from(packages).where(eq(packages.name, body.name)).get()!;
      if (body.file !== undefined) {
        // Атомарность: сначала фс, потом бд; при сбое бд — компенсация.
        await writeArtifactToRepos(db, pkg, body.name, body.version, body.file, adapter);
      }
      try {
        db.insert(versions)
          .values({
            packageName: body.name,
            version: body.version,
            sha256: body.file !== undefined ? sha256(body.file) : "",
            createdAt: now,
          })
          .run();
      } catch (error) {
        // ATOM-01: компенсация — удалить записанное в фс.
        if (body.file !== undefined) {
          await removeArtifactFromRepos(db, pkg, body.name, body.version);
        }
        throw error;
      }
    }

    logger.info("package created", { req_id: reqId, name: body.name });
    const pkg = db.select().from(packages).where(eq(packages.name, body.name)).get();
    return c.json(buildPackageResponse(deps, pkg!), 201);
  });

  // ADD-03. Добавление версии.
  app.post("/:name/versions", async (c) => {
    const name = c.req.param("name");
    if (!nameSchema.safeParse(name).success) return c.json({ error: "invalid_request" }, 400);
    let body: z.infer<typeof versionBodySchema>;
    try {
      body = versionBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    const pkg = db.select().from(packages).where(eq(packages.name, name)).get();
    if (!pkg) return c.json({ error: "not_found" }, 404);
    if (body.file !== undefined && pkg.repositories.length === 0) {
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
    if (body.file !== undefined) {
      await writeArtifactToRepos(db, pkg, name, body.version, body.file, adapter);
    }
    db.insert(versions)
      .values({
        packageName: name,
        version: body.version,
        sha256: body.file !== undefined ? sha256(body.file) : "",
        createdAt: now,
      })
      .run();
    return c.json(buildPackageResponse(deps, pkg), 201);
  });

  // PKG-01, UPD-02, GET одного пакета.
  app.get("/:name", (c) => {
    const name = c.req.param("name");
    const pkg = db.select().from(packages).where(eq(packages.name, name)).get();
    if (!pkg) return c.json({ error: "not_found" }, 404);
    return c.json(buildPackageResponse(deps, pkg));
  });

  // UPD-02, ADD-05. Обновление полей пакета.
  app.put("/:name", async (c) => {
    const name = c.req.param("name");
    const pkg = db.select().from(packages).where(eq(packages.name, name)).get();
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
    const updated = db.select().from(packages).where(eq(packages.name, name)).get();
    return c.json(buildPackageResponse(deps, updated!));
  });

  // MOV-01..06. Размещение в репозиториях.
  app.patch("/:name", async (c) => {
    const name = c.req.param("name");
    const pkg = db.select().from(packages).where(eq(packages.name, name)).get();
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
    const fresh = db.select().from(packages).where(eq(packages.name, name)).get()!;
    for (const row of rowData) {
      try {
        const content = await (async () => {
          for (const repo of reposOf(db, fresh)) {
            const target = join(repo.path, artifactFileName(name, row.version, repo.type));
            try {
              return await import("node:fs/promises").then((m) => m.readFile(target, "utf8"));
            } catch {
              // not in this repo
            }
          }
          return undefined;
        })();
        if (content === undefined) continue;
        await writeArtifactToRepos(db, fresh, name, row.version, content);
      } catch {
        // не блокирует размещение
      }
    }
    const updated = db.select().from(packages).where(eq(packages.name, name)).get();
    return c.json(buildPackageResponse(deps, updated!));
  });

  // DEL-01. Удаление пакета целиком.
  app.delete("/:name", async (c) => {
    const name = c.req.param("name");
    const pkg = db.select().from(packages).where(eq(packages.name, name)).get();
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
    try {
      body = versionUpdateBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    const pkg = db.select().from(packages).where(eq(packages.name, name)).get();
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
          sha256: body.file !== undefined ? sha256(body.file) : "",
          createdAt: now,
        })
        .run();
      const created = db.select().from(packages).where(eq(packages.name, name)).get();
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
          sha256: body.file !== undefined ? sha256(body.file) : "",
          createdAt: now,
        })
        .run();
      if (body.file !== undefined) {
        await writeArtifactToRepos(db, pkg, name, version, body.file, adapter);
      }
      return c.json(buildPackageResponse(deps, pkg));
    }

    if (body.file === undefined) {
      // Нет файла — обновляем только поля (UPD-02). Других полей нет.
      return c.json(buildPackageResponse(deps, pkg));
    }

    const newHash = sha256(body.file);
    // UPD-04: полное совпадение параметров — ошибка.
    if (row.sha256 === newHash) {
      return c.json({ error: "no_changes" }, 409);
    }
    // UPD-01: перезапись при разной хэшсумме — варнинг.
    await writeArtifactToRepos(db, pkg, name, version, body.file, adapter);
    db.update(versions)
      .set({ sha256: newHash })
      .where(and(eq(versions.packageName, name), eq(versions.version, version)))
      .run();
    return c.json({ warning: true });
  });

  // TST-01: фантом нельзя тестировать.
  app.post("/:name/test", async (c) => {
    const name = c.req.param("name");
    const pkg = db.select().from(packages).where(eq(packages.name, name)).get();
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
    const pkg = db.select().from(packages).where(eq(packages.name, name)).get();
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

/** Шаблонизатор url: подставляет `{id}` и `{name}`/`{version}` в url запуска. */
function templatizeUrl(url: string, values: Record<string, string>): string {
  let result = url;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

async function startTest(
  c: Context,
  deps: PackageApiDeps,
  orch: OrchClient,
  name: string,
  version: string,
) {
  const db = deps.db;
  let body: z.infer<typeof runBodySchema>;
  try {
    body = runBodySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  const pkg = db.select().from(packages).where(eq(packages.name, name)).get();
  if (!pkg) return c.json({ error: "not_found" }, 404);
  const testUrl = body.testUrl ?? pkg.testUrl ?? deps.commonTestUrl;
  // TST-06/ORCH-01: url теста не задан — ошибка.
  if (!testUrl) return c.json({ error: "no_test_url" }, 400);

  const reqId = c.get("reqId");
  const now = new Date();
  db.insert(testJournal)
    .values({
      id: reqId,
      packageName: name,
      version,
      status: "running",
      invalid: false,
      body: null,
      createdAt: now,
    })
    .run();

  const launchUrl = templatizeUrl(testUrl, { id: reqId });
  const result = await orch.start(launchUrl);
  if (!result.ok) {
    // TST-05: сбой запуска процесса — запись в журнал как ошибка.
    db.update(testJournal)
      .set({ status: "error" })
      .where(eq(testJournal.id, reqId))
      .run();
    return c.json({ error: "process_start_failed" }, 502);
  }
  // TST-07: ответ на вызов url запуска сохраняется в запись журнала.
  if (result.response !== undefined) {
    db.update(testJournal)
      .set({ body: result.response })
      .where(eq(testJournal.id, reqId))
      .run();
  }
  return c.json({ id: reqId }, 202);
}

async function startBuild(
  c: Context,
  deps: PackageApiDeps,
  orch: OrchClient,
  name: string,
  version: string,
) {
  const db = deps.db;
  const pkg = db.select().from(packages).where(eq(packages.name, name)).get();
  if (!pkg) return c.json({ error: "not_found" }, 404);
  const buildUrl = pkg.buildUrl ?? deps.commonBuildUrl;
  // ORCH-01: нет настроенных процессов — ошибка.
  if (!buildUrl) return c.json({ error: "no_build_url" }, 400);

  const reqId = c.get("reqId");
  const now = new Date();
  db.insert(buildJournal)
    .values({
      id: reqId,
      packageName: name,
      version,
      resultVersion: null,
      status: "running",
      invalid: false,
      body: null,
      createdAt: now,
    })
    .run();

  const launchUrl = templatizeUrl(buildUrl, { id: reqId });
  const result = await orch.start(launchUrl);
  if (!result.ok) {
    db.update(buildJournal)
      .set({ status: "error" })
      .where(eq(buildJournal.id, reqId))
      .run();
    return c.json({ error: "process_start_failed" }, 502);
  }
  if (result.response !== undefined) {
    db.update(buildJournal)
      .set({ body: result.response })
      .where(eq(buildJournal.id, reqId))
      .run();
  }
  return c.json({ id: reqId }, 202);
}