import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { packages, repositories, versions } from "../../db/schema.js";
import { createLogger } from "../../logger.js";
import type { PackageApiDeps } from "./deps.js";
import { resolveAdapter } from "./deps.js";
import { artifactFileName, sha256 } from "./artifacts.js";

/**
 * Сканирование репозиториев и подхват артефактов, появившихся на диске вне API (SVR-03).
 * Общая логика для ручного POST /sync и периодического таймера (index.ts).
 */
export async function runSync(
  deps: PackageApiDeps,
  reqId = "",
): Promise<{ ok: true; picked: number }> {
  const db = deps.db;
  const logger = deps.logger ?? createLogger({ level: "info" });
  const adapter = resolveAdapter(deps, logger);
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
      const parsed = await adapter.inspect(repo.type, join(repo.path, file));
      if (!parsed) {
        // неразбираемое имя файла — только логируется, ошибкой не становится
        logger.warn("sync: cannot parse artifact", { req_id: reqId, repo: repo.name, file });
        continue;
      }
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
      let content: Buffer;
      try {
        content = await readFile(target);
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
      await adapter.update(repo.path, repo.type, name, version);
      picked += 1;
      logger.info("sync: picked artifact", { req_id: reqId, name, version, repo: repo.name });
    }
  }
  logger.info("sync done", { req_id: reqId, picked });
  return { ok: true, picked };
}