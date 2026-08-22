import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  createRepoAdapter,
  inspectPackage,
  type ExecFn,
} from "../src/repoAdapter.js";
import { memoryLogger } from "./helpers.js";

const opts = { useUtilities: true };

/** Доступность системной утилиты (для интеграционных тестов). */
function hasTool(tool: string): boolean {
  try {
    return spawnSync("/usr/bin/env", ["sh", "-c", `command -v ${tool}`]).status === 0;
  } catch {
    return false;
  }
}

function execReturning(stdout: string, code = 0): ExecFn {
  return async () => ({ stdout, code });
}

function execFailing(error: Error): ExecFn {
  return async () => {
    throw error;
  };
}

function tempFile(name: string, content = "content"): string {
  const dir = mkdtempSync(join(tmpdir(), "wm-repo-adapter-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("inspectPackage: утилита пакетной системы", () => {
  // PRS-01. rpm через утилиту
  it("разбирает rpm выводом утилиты", async () => {
    const exec = execReturning("bash\n5.2.37-2.x86_64\n");
    const got = await inspectPackage("rpm", "/tmp/bash-5.2.37-2.x86_64.rpm", {
      ...opts,
      exec,
    });
    expect(got).toEqual({ name: "bash", version: "5.2.37-2.x86_64" });
  });

  // PRS-02. rpm с релизом-ос
  it("сохраняет релиз-ос в версии", async () => {
    const exec = execReturning("nginx\n1.24.0-1.el9.x86_64\n");
    const got = await inspectPackage("rpm", "/tmp/nginx-1.24.0-1.el9.x86_64.rpm", {
      ...opts,
      exec,
    });
    expect(got).toEqual({ name: "nginx", version: "1.24.0-1.el9.x86_64" });
  });
});

describe("inspectPackage: фолбэк", () => {
  // PRS-04. Утилита не найдена/не выполнилась — варнинг и фолбэк
  it("варнит и фолбэчит на парсер при недоступной утилите", async () => {
    const { logger, lines } = memoryLogger();
    const exec = execFailing(new Error("spawn rpm ENOENT"));
    const got = await inspectPackage(
      "rpm",
      "/tmp/bash-5.2.37-2.x86_64.rpm",
      { ...opts, exec, logger },
    );
    expect(got).toEqual({ name: "bash", version: "5.2.37-2.x86_64" });
    expect(lines.join("\n")).toContain("inspect: package utility unavailable");
  });

  // PRS-05. Утилиты не включены — только парсер имени файла
  it("не вызывает утилиту при выключенном использовании", async () => {
    let called = false;
    const exec: ExecFn = async () => {
      called = true;
      return { stdout: "bash\n5.2.37-2.x86_64\n", code: 0 };
    };
    const got = await inspectPackage("rpm", "/tmp/bash-5.2.37-2.x86_64.rpm", {
      useUtilities: false,
      exec,
    });
    expect(got).toEqual({ name: "bash", version: "5.2.37-2.x86_64" });
    expect(called).toBe(false);
  });

  // PRS-05. Утилита выполнилась, но файл — не пакет
  it("фолбэчит на парсер при неудачном разборе утилитой", async () => {
    const exec = execReturning("", 1);
    const got = await inspectPackage("rpm", "/tmp/bash-5.2.37-2.x86_64.rpm", {
      ...opts,
      exec,
    });
    expect(got).toEqual({ name: "bash", version: "5.2.37-2.x86_64" });
  });

  it("возвращает undefined, когда утилита и парсер не разобрали", async () => {
    const exec = execFailing(new Error("spawn rpm ENOENT"));
    const got = await inspectPackage("rpm", "/tmp/README.txt", { ...opts, exec });
    expect(got).toBeUndefined();
  });

  it("возвращает undefined для неизвестного типа", async () => {
    const got = await inspectPackage("slackware", "/tmp/pkg.txz", { ...opts });
    expect(got).toBeUndefined();
  });

  // Интеграция: реальная утилита через /usr/bin/env (если есть) + фолбэк.
  it.skipIf(!hasTool("rpm"))("интеграция: файл не пакет → фолбэк на парсер имени", async () => {
    const file = tempFile("bash-5.2.37-2.x86_64.rpm");
    const got = await inspectPackage("rpm", file, { ...opts });
    expect(got).toEqual({ name: "bash", version: "5.2.37-2.x86_64" });
  });
});

describe("createRepoAdapter", () => {
  it("inspect и update не бросают исключений", async () => {
    const adapter = createRepoAdapter({ useUtilities: false, exec: execReturning("") });
    const got = await adapter.inspect("rpm", "/tmp/nginx-1.24.0-1.el9.x86_64.rpm");
    expect(got).toEqual({ name: "nginx", version: "1.24.0-1.el9.x86_64" });
    await expect(adapter.update("/tmp", "rpm", "nginx", "1.24.0-1.el9.x86_64")).resolves.toBeUndefined();
  });

  it("предупреждает и пропускает генератор, которого нет в системе", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-rpmgen-"));
    const warnings: unknown[] = [];
    const adapter = createRepoAdapter({
      useUtilities: false,
      exec: async () => {
        throw new Error("ENOENT: no such tool");
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: (m: string, d?: unknown) => warnings.push([m, d]),
        error: () => {},
      } as never,
    });
    await adapter.update(dir, "rpm", "nginx", "1.24.0-1.el9.x86_64");
    expect(warnings.length).toBeGreaterThan(0);
  });
});
