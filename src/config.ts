import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadEnvFile } from "node:process";
import path from "node:path";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SERVER_HOST: z.string().min(1).default("0.0.0.0"),
  SERVER_PORT: z.coerce.number().int().positive().max(65535).default(34817),
  DATABASE_PATH: z.string().min(1).default("data/watermelon.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof envSchema>;

export interface CliConfig {
  host?: string;
  port?: number;
}

export interface ConfigOptions {
  configFile?: string;
  cli?: CliConfig;
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const raw = readFileSync(filePath, "utf8");
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return {};
    }
    return data as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toEnvValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/** Приоритет (низший → высший): конфиг-файл, env, cli. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = process.cwd(),
  options: ConfigOptions = {},
): Config {
  const fromFile = options.configFile
    ? Object.fromEntries(
        Object.entries(readJsonFile(options.configFile)).flatMap(([k, v]) => {
          const value = toEnvValue(v);
          return value === undefined ? [] : [[k, value]];
        }),
      )
    : {};
  const fromCli: NodeJS.ProcessEnv = {};
  if (options.cli?.host !== undefined) fromCli.SERVER_HOST = options.cli.host;
  if (options.cli?.port !== undefined) fromCli.SERVER_PORT = String(options.cli.port);

  const merged: NodeJS.ProcessEnv = { ...fromFile, ...env, ...fromCli };

  const parsed = envSchema.parse(merged);
  return {
    ...parsed,
    DATABASE_PATH: path.isAbsolute(parsed.DATABASE_PATH)
      ? parsed.DATABASE_PATH
      : path.join(baseDir, parsed.DATABASE_PATH),
  };
}

export function loadDotEnv(filePath: string): void {
  try {
    loadEnvFile(filePath);
  } catch {
    // .env is optional; fall back to process environment.
  }
}