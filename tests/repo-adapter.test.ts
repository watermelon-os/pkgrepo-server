import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

  // PRS-03. deb через утилиту
  it("собирает deb-версию из Version и Architecture", async () => {
    const exec = execReturning("nginx\n1.24.0\namd64\n");
    const got = await inspectPackage("deb", "/tmp/nginx_1.24.0_amd64.deb", {
      ...opts,
      exec,
    });
    expect(got).toEqual({ name: "nginx", version: "1.24.0_amd64" });
  });

  // deb: фолбэк, когда dpkg-deb недоступен/не разобрал — dpkg --info
  it("разбирает deb через dpkg --info (фолбэк)", async () => {
    const block = [
      " new Debian package, version 2.0.",
      " size 16947844 bytes: control archive=352 bytes.",
      " Package: helix",
      " Version: 25.7.1-1",
      " Architecture: amd64",
      " Homepage: https://helix-editor.com",
    ].join("\n");
    const exec: ExecFn = async (cmd) =>
      cmd === "dpkg-deb" ? { stdout: "", code: 2 } : { stdout: block, code: 0 };
    const got = await inspectPackage("deb", "/tmp/helix_25.7.1-1_amd64.deb", {
      ...opts,
      exec,
    });
    expect(got).toEqual({ name: "helix", version: "25.7.1-1_amd64" });
  });

  it("разбирает pacman из .PKGINFO", async () => {
    const exec = execReturning("pkgname = bash\npkgver = 5.2.37-2\narch = x86_64\n");
    const got = await inspectPackage("pacman", "/tmp/bash-5.2.37-2-x86_64.pkg.tar.zst", {
      ...opts,
      exec,
    });
    expect(got).toEqual({ name: "bash", version: "5.2.37-2-x86_64" });
  });

  // pacman: исходный архив — фолбэк через чтение PKGBUILD
  it("разбирает pacman из PKGBUILD (исходный архив)", async () => {
    const pkgbuild = [
      "pkgname=fcitx5-ari-ime",
      "pkgver=2.4.0",
      "pkgrel=1",
      "arch=('x86_64')",
      "url=\"https://github.com/kaiyasi/Ari-IME\"",
    ].join("\n");
    const exec: ExecFn = async (cmd, args) => {
      if (args.includes(".PKGINFO")) return { stdout: "", code: 2 };
      return { stdout: pkgbuild, code: 0 };
    };
    const got = await inspectPackage("pacman", "/tmp/downloads/fcitx5-ari-ime.tar.gz", {
      ...opts,
      exec,
    });
    expect(got).toEqual({ name: "fcitx5-ari-ime", version: "2.4.0-1-x86_64" });
  });
});

describe("inspectPackage: фолбэк", () => {
  // PRS-04. Утилита не найдена/не выполнилась — варнинг и фолбэк
  it("варнит и фолбэчит на парсер при недоступной утилите", async () => {
    const { logger, lines } = memoryLogger();
    const exec = execFailing(new Error("spawn dpkg-deb ENOENT"));
    const got = await inspectPackage(
      "deb",
      "/tmp/bash_5.2.37-2_amd64.deb",
      { ...opts, exec, logger },
    );
    expect(got).toEqual({ name: "bash", version: "5.2.37-2_amd64" });
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
  it("интеграция: файл не пакет → фолбэк на парсер имени", async () => {
    const file = tempFile("bash-5.2.37-2.x86_64.rpm");
    const got = await inspectPackage("rpm", file, { ...opts });
    expect(got).toEqual({ name: "bash", version: "5.2.37-2.x86_64" });
  });

  it("интеграция: pacman из PKGBUILD исходного архива", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-pkgbuild-"));
    const pkgDir = join(dir, "fcitx5-ari-ime");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "PKGBUILD"),
      "pkgname=fcitx5-ari-ime\npkgver=2.4.0\npkgrel=1\narch=('x86_64')\n",
    );
    execFileSync("/usr/bin/env", ["tar", "-czf", join(dir, "src.tar.gz"), "-C", dir, "fcitx5-ari-ime"]);
    const got = await inspectPackage("pacman", join(dir, "src.tar.gz"), { ...opts });
    expect(got).toEqual({ name: "fcitx5-ari-ime", version: "2.4.0-1-x86_64" });
  });
});

describe("createRepoAdapter", () => {
  it("inspect и update не бросают исключений", async () => {
    const adapter = createRepoAdapter({ useUtilities: false, exec: execReturning("") });
    const got = await adapter.inspect("rpm", "/tmp/nginx-1.24.0-1.el9.x86_64.rpm");
    expect(got).toEqual({ name: "nginx", version: "1.24.0-1.el9.x86_64" });
    await expect(adapter.update("/tmp", "rpm", "nginx", "1.24.0-1.el9.x86_64")).resolves.toBeUndefined();
  });

  it("генерирует Packages для deb через dpkg-scanpackages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-debgen-"));
    const adapter = createRepoAdapter({
      useUtilities: false,
      exec: execReturning("Package: whatever\nVersion: 1.0.0-1_amd64\n"),
    });
    await adapter.update(dir, "deb", "whatever", "1.0.0-1_amd64");
    expect(existsSync(join(dir, "Packages"))).toBe(true);
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