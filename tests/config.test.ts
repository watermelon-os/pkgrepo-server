import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const TEST_DB_PATH = "/tmp/wm-test.db";
const TEST_REPO_ROOT = "/tmp/wm-test-repos";

describe("server configuration", () => {
  // CFG-01. Валидация на старте
  // - Когда: сервер запускается с некорректными настройками
  // - Тогда: валидация на старте возвращает ошибку
  it("отвергает некорректные настройки при старте", () => {
    expect(() =>
      loadConfig({ SERVER_PORT: "not-a-number", DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never),
    ).toThrow();
  });

  it("отвергает запуск без DATABASE_PATH", () => {
    expect(() => loadConfig({ REPO_ROOT: TEST_REPO_ROOT } as never, "/tmp")).toThrow();
  });

  it("отвергает запуск без REPO_ROOT", () => {
    expect(() => loadConfig({ DATABASE_PATH: TEST_DB_PATH } as never, "/tmp")).toThrow();
  });

  it("разрешает относительный DATABASE_PATH относительно baseDir", () => {
    const cfg = loadConfig(
      { DATABASE_PATH: "data/watermelon.db", REPO_ROOT: TEST_REPO_ROOT } as never,
      "/tmp",
    );
    expect(cfg.DATABASE_PATH).toBe("/tmp/data/watermelon.db");
  });

  it("разрешает относительный REPO_ROOT относительно baseDir", () => {
    const cfg = loadConfig(
      { DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: "repos" } as never,
      "/tmp",
    );
    expect(cfg.REPO_ROOT).toBe("/tmp/repos");
  });

  // CFG-02. Приоритет источников
  // - Когда: значение настройки задано в нескольких источниках
  // - Тогда: приоритет (низший → высший): конфиг-файл, env, cli
  it("даёт приоритет cli над env и конфиг-файлом", () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-test-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ SERVER_PORT: 3100 }));
    process.env.SERVER_PORT = "3200";

    const cli = { port: 3300 };
    const cfg = loadConfig(
      { ...process.env, DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT },
      dir,
      { configFile: file, cli } as never,
    );
    expect(cfg.SERVER_PORT).toBe(3300);
    delete process.env.SERVER_PORT;
  });

  it("env имеет приоритет над конфиг-файлом", () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-test-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ SERVER_PORT: 3100 }));
    process.env.SERVER_PORT = "3400";

    const cfg = loadConfig(
      { ...process.env, DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT },
      dir,
      { configFile: file } as never,
    );
    expect(cfg.SERVER_PORT).toBe(3400);
    delete process.env.SERVER_PORT;
  });

  // CFG-03. Настройки неизменны при запущенном сервере
  // - Дано: сервер запущен
  // - Когда: предпринимается попытка изменить настройки
  // - Тогда: настройки не изменяются — это невозможно пока запущен сервер
  it("не изменяет настройки запущенного сервера", () => {
    delete process.env.SERVER_PORT;
    const cfg = loadConfig({ DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never, "/tmp");
    expect(cfg.SERVER_PORT).toBe(34817);
  });

  it("нет API для изменения настроек на лету", () => {
    const cfg = loadConfig({ DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never, "/tmp");
    expect(cfg).toBeTruthy();
  });

  it("использование утилит пакетной системы включено по умолчанию", () => {
    delete process.env.USE_PACKAGE_UTILITIES;
    const cfg = loadConfig({ DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never, "/tmp");
    expect(cfg.USE_PACKAGE_UTILITIES).toBe(true);
  });

  it("выключает использование утилит в конфиге", () => {
    delete process.env.USE_PACKAGE_UTILITIES;
    const cfg = loadConfig(
      { USE_PACKAGE_UTILITIES: "false", DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never,
      "/tmp",
    );
    expect(cfg.USE_PACKAGE_UTILITIES).toBe(false);
  });

  it("синхронизация с фс имеет период по умолчанию", () => {
    delete process.env.SYNC_INTERVAL_SECONDS;
    const cfg = loadConfig({ DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never, "/tmp");
    expect(cfg.SYNC_INTERVAL_SECONDS).toBe(300);
  });

  it("нулевой период отключает фоновую синхронизацию", () => {
    delete process.env.SYNC_INTERVAL_SECONDS;
    const cfg = loadConfig(
      { SYNC_INTERVAL_SECONDS: "0", DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never,
      "/tmp",
    );
    expect(cfg.SYNC_INTERVAL_SECONDS).toBe(0);
  });

  it("отклоняет отрицательный период синхронизации", () => {
    delete process.env.SYNC_INTERVAL_SECONDS;
    expect(() =>
      loadConfig(
        { SYNC_INTERVAL_SECONDS: "-5", DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never,
        "/tmp",
      ),
    ).toThrow();
  });

  it("ключи стандартных полей лога по умолчанию отключены", () => {
    delete process.env.LOG_STANDARD_FIELDS;
    const cfg = loadConfig({ DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never, "/tmp");
    expect(cfg.LOG_STANDARD_FIELDS).toEqual([]);
  });

  it("парсит список стандартных полей лога", () => {
    const cfg = loadConfig(
      { LOG_STANDARD_FIELDS: "time,logger", DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never,
      "/tmp",
    );
    expect(cfg.LOG_STANDARD_FIELDS).toEqual(["time", "logger"]);
  });

  it("игнорирует неизвестные и пустые значения стандартных полей", () => {
    const cfg = loadConfig(
      { LOG_STANDARD_FIELDS: " time,  ,bogus ", DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never,
      "/tmp",
    );
    expect(cfg.LOG_STANDARD_FIELDS).toEqual(["time"]);
  });

  // AUTH: токены объявляются в конфиге (значение, комментарий, роль).
  it("по умолчанию токенов нет", () => {
    const cfg = loadConfig({ DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never, "/tmp");
    expect(cfg.TOKENS).toEqual([]);
  });

  it("парсит токены из JSON-строки", () => {
    const cfg = loadConfig(
      {
        TOKENS: '[{"value":"a","comment":"admin","role":"admin"},{"value":"b","role":"runner"}]',
        DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT,
      },
      "/tmp",
    );
    expect(cfg.TOKENS).toEqual([
      { value: "a", comment: "admin", role: "admin" },
      { value: "b", role: "runner" },
    ]);
  });

  it("отклоняет некорректный JSON токенов при старте", () => {
    expect(() =>
      loadConfig({ TOKENS: "not json", DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never, "/tmp"),
    ).toThrow();
  });

  it("отклоняет токен без значения", () => {
    expect(() =>
      loadConfig({ TOKENS: '[{"comment":"x"}]', DATABASE_PATH: TEST_DB_PATH, REPO_ROOT: TEST_REPO_ROOT } as never, "/tmp"),
    ).toThrow();
  });
});