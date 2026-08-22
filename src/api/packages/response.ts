import { eq } from "drizzle-orm";
import { versions } from "../../db/schema.js";
import type { PackageApiDeps } from "./deps.js";

interface PackageRow {
  name: string;
  repositories: string[];
}

export function buildPackageResponse(
  _deps: PackageApiDeps,
  pkg: PackageRow,
): {
  name: string;
  versions: Array<{ version: string; repositories: string[] }>;
  repositories: string[];
} {
  const db = _deps.db;
  const versionRows = db
    .select()
    .from(versions)
    .where(eq(versions.packageName, pkg.name))
    .all()
    .sort((a, b) => a.version.localeCompare(b.version));
  return {
    name: pkg.name,
    versions: versionRows.map((row) => ({
      version: row.version,
      repositories: pkg.repositories,
    })),
    repositories: pkg.repositories,
  };
}
