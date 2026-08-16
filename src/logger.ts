export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

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
}

interface Internal {
  level: LogLevel;
  name: string;
  base: LogFields;
  stream: { write(line: string): void };
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

  function write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < threshold) return;
    const parts = [
      `time=${new Date().toISOString()}`,
      `level=${level.toUpperCase()}`,
      `logger=${internal.name}`,
      `msg=${formatValue(msg)}`,
    ];
    const merged = { ...internal.base, ...(fields ?? {}) };
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) continue;
      parts.push(`${key}=${formatValue(value)}`);
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
    name: options.name ?? "watermelon-server-ts",
    base: {},
    stream: options.stream ?? process.stdout,
  });
}