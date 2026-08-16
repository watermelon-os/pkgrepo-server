import { readFile } from "node:fs/promises";
import path from "node:path";

const cache = new Map<string, string>();

export async function readVersion(baseDir: string = process.cwd()): Promise<string> {
  const pkgPath = path.join(baseDir, "package.json");
  let version = cache.get(pkgPath);
  if (version === undefined) {
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    version = pkg.version ?? "0.0.0";
    cache.set(pkgPath, version);
  }
  return version;
}
