import { readFile } from "node:fs/promises";

const cache = new Map<string, string>();

// package.json ищется относительно модуля (на уровень выше dist/ при
// сборке и src/ при разработке), а не cwd: сервер может стартовать
// из любого каталога (systemd, cron и т.д.).
export async function readVersion(): Promise<string> {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const key = pkgUrl.href;
  let version = cache.get(key);
  if (version === undefined) {
    const raw = await readFile(pkgUrl, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    version = pkg.version ?? "0.0.0";
    cache.set(key, version);
  }
  return version;
}