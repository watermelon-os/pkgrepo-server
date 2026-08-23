import { APP_NAME } from "./constants.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

const COLORS = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: COLORS.gray,
  info: COLORS.green,
  warn: COLORS.yellow,
  error: COLORS.red,
};

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  name?: string;
  stream?: { write(line: string): void };
  /**
   * Стандартные поля, у которых показывать ключ (time, level, logger, msg).
   * По умолчанию пусто — ключи скрыты, значения выводятся без префикса.
   */
  standardFields?: string[];
}

interface Internal {
  level: LogLevel;
  name: string;
  base: LogFields;
  stream: { write(line: string): void };
  standardFields?: string[];
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s"'=]/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return JSON.stringify(value);
}

function fromInternal(internal: Internal): Logger {
  const threshold = LEVEL_RANK[internal.level];
  // Цвета — только для TTY (терминал); иначе лог остаётся plain (тесты/пайпы).
  const color = (internal.stream as { isTTY?: boolean }).isTTY === true;
  const painted = (text: string, code: string): string =>
    color ? `${code}${text}${COLORS.reset}` : text;
  const dimmed = (text: string): string => (color ? `${COLORS.dim}${text}${COLORS.reset}` : text);

  function write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < threshold) return;
    const standard = internal.standardFields ?? [];
    const hasKey = (field: string): boolean => standard.includes(field);
    const now = new Date().toISOString();
    const levelValue = level.toUpperCase();
    const parts = [
      dimmed(hasKey("time") ? `time=${now}` : now),
      painted(hasKey("level") ? `level=${levelValue}` : levelValue, LEVEL_COLOR[level]),
      dimmed(hasKey("logger") ? `logger=${internal.name}` : internal.name),
      painted(hasKey("msg") ? `msg=${formatValue(msg)}` : formatValue(msg), LEVEL_COLOR[level]),
    ];
    const merged = { ...internal.base, ...(fields ?? {}) };
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) continue;
      parts.push(`${color ? COLORS.dim : ""}${key}=${color ? COLORS.reset : ""}${formatValue(value)}`);
    }
    internal.stream.write(`${parts.join(" ")}\n`);
  }

  return {
    level: internal.level,
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) =>
      fromInternal({
        ...internal,
        base: { ...internal.base, ...fields },
      }),
  };
}

export function createLogger(options: LoggerOptions): Logger {
  return fromInternal({
    level: options.level,
    name: options.name ?? APP_NAME,
    base: {},
    stream: options.stream ?? process.stdout,
    standardFields: options.standardFields,
  });
}