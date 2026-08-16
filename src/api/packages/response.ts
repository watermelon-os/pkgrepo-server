import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/index.js";
import { buildJournal, testJournal, versions } from "../../db/schema.js";
import type { PackageApiDeps } from "./deps.js";

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

export function buildPackageResponse(
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