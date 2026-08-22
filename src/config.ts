import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadEnvFile } from "node:process";
import path from "node:path";
import type { Token } from "./types.js";

const tokensSchema = z
  .preprocess(
    (value) => {
      if (value === undefined || value === "") return [];
      // AUTH: токены объявляются в конфиге/окружении как JSON-строка.
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(value));
      } catch {
        throw new Error("TOKENS must be a JSON array of token objects");
      }
      return parsed;
    },
    z.array(z.object({ value: z.string().min(1), comment: z.string().optional(), role: z.string().optional() })),
  )
  .transform((tokens) => tokens as Token[]);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SERVER_HOST: z.string().min(1).default("0.0.0.0"),
  SERVER_PORT: z.coerce.number().int().positive().max(65535).default(34817),
  DATABASE_PATH: z.string().min(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Стандартные поля лога в каждой строке (time, level, logger, msg), через запятую.
  // По умолчанию пусто — ключи стандартных полей скрыты, значения выводятся.
  LOG_STANDARD_FIELDS: z.preprocess(
    (value) =>
      value === undefined
        ? []
        : String(value)
            .toLowerCase()
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s && ["time", "level", "logger", "msg"].includes(s)),
    z.array(z.enum(["time", "level", "logger", "msg"])).default([]),
  ),
  // Корневой каталог репозиториев; обязателен.
  REPO_ROOT: z.string().min(1),
  USE_PACKAGE_UTILITIES: z
    .preprocess(
      (value) => (value === undefined ? undefined : String(value).toLowerCase()),
      z.enum(["true", "false", "1", "0"]).default("true"),
    )
    .transform((value) => value === "true" || value === "1"),
  // Период фоновой синхронизации с фс в секундах; 0 — выключить.
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
  // Логировать сканы синхронизации, не нашедшие ни одного пакета (по умолчанию да).
  SYNC_LOG_EMPTY: z
    .preprocess(
      (value) => (value === undefined ? undefined : String(value).toLowerCase()),
      z.enum(["true", "false", "1", "0"]).default("true"),
    )
    .transform((value) => value === "true" || value === "1"),
  // Аутентификация: JSON-массив токенов `[{"value","comment?","role?"}]`.
  // Пусто/не задано — авторизация выключена.
  TOKENS: tokensSchema,
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
    REPO_ROOT: path.isAbsolute(parsed.REPO_ROOT)
      ? parsed.REPO_ROOT
      : path.join(baseDir, parsed.REPO_ROOT),
  };
}

export function loadDotEnv(filePath: string): void {
  try {
    loadEnvFile(filePath);
  } catch {
    // .env is optional; fall back to process environment.
  }
}