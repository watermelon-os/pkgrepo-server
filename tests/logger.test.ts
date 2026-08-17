import { describe, it, expect } from "vitest";
import { createLogger, type LoggerOptions } from "../src/logger.js";

interface Capture {
  logger: ReturnType<typeof createLogger>;
  lines: string[];
}

function capture(level: LoggerOptions["level"], options: Partial<LoggerOptions> = {}): Capture {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    name: "test",
    ...options,
    stream: { write: (line) => lines.push(line) },
  });
  return { logger, lines };
}

describe("logger: ключи стандартных полей", () => {
  it("по умолчанию ключи скрыты, значения сохраняются", () => {
    const { logger, lines } = capture("info");
    logger.info("hello", { foo: "bar" });
    const line = lines[0]!;
    expect(line).not.toContain("time=");
    expect(line).not.toContain("level=");
    expect(line).not.toContain("logger=");
    expect(line).not.toContain("msg=");
    expect(line).toMatch(/^\S+ INFO test hello foo=bar\s*$/);
  });

  it("показывает ключи по списку standardFields", () => {
    const { logger, lines } = capture("info", {
      standardFields: ["time", "level", "logger", "msg"],
    });
    logger.info("hello");
    const line = lines[0]!;
    expect(line).toMatch(/^time=\S+ level=INFO logger=test msg=hello\s*$/);
  });

  it("показывает ключи только выбранных полей", () => {
    const { logger, lines } = capture("info", { standardFields: ["level", "msg"] });
    logger.info("hello", { foo: "bar" });
    const line = lines[0]!;
    expect(line).toContain("level=INFO");
    expect(line).toContain("msg=hello");
    expect(line).not.toContain("time=");
    expect(line).not.toContain("logger=");
    expect(line).toContain("foo=bar");
  });
});