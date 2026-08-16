import { z } from "zod";
import { loadEnvFile } from "node:process";
import path from "node:path";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SERVER_HOST: z.string().min(1).default("0.0.0.0"),
  SERVER_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default("data/watermelon.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = process.cwd(),
): Config {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    DATABASE_PATH: path.isAbsolute(parsed.DATABASE_PATH)
      ? parsed.DATABASE_PATH
      : path.join(baseDir, parsed.DATABASE_PATH),
  };
}

export function loadDotEnv(path: string): void {
  try {
    loadEnvFile(path);
  } catch {
    // .env is optional; fall back to process environment.
  }
}
