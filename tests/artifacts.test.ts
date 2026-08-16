import { describe, it, expect } from "vitest";
import { parseRpmName, parseDebName, artifactFileName } from "../src/artifacts.js";

describe("artifact name parsing", () => {
  // PRS-01. rpm: имя-версия-релиз
  // - Дано: rpm-файл по шаблону `имя-версия-релиз` (например `nginx-1.24.0-1.el9.rpm`)
  // - Тогда: имя = nginx, версия = 1.24.0-1.el9 (релиз — часть версии)
  it("разбирает rpm: имя-версия-релиз", () => {
    const parsed = parseRpmName("nginx-1.24.0-1.el9.rpm");
    expect(parsed).toEqual({ name: "nginx", version: "1.24.0-1.el9" });
  });

  // PRS-02. rpm без релиза
  it("разбирает rpm без релиза", () => {
    const parsed = parseRpmName("nginx-1.24.0.rpm");
    expect(parsed).toEqual({ name: "nginx", version: "1.24.0" });
  });

  // PRS-03. deb: имя_версия_архитектура
  it("разбирает deb: имя_версия_архитектура", () => {
    const parsed = parseDebName("nginx_1.24.0_amd64.deb");
    expect(parsed).toEqual({ name: "nginx", version: "1.24.0" });
  });

  it("разбирает deb без версии-релиза с дефисами в архитектуре", () => {
    const parsed = parseDebName("python3.11_3.11.9-1_amd64.deb");
    expect(parsed).toEqual({ name: "python3.11", version: "3.11.9-1" });
  });

  // PRS-04. Неразбираемое имя
  it("возвращает undefined для неразбираемого rpm", () => {
    expect(parseRpmName("README.txt")).toBeUndefined();
    expect(parseRpmName("nginx.rpm")).toBeUndefined();
  });

  it("возвращает undefined для неразбираемого deb", () => {
    expect(parseDebName("README.txt")).toBeUndefined();
    expect(parseDebName("nginx.deb")).toBeUndefined();
  });

  // PRS-05. Сборка имени файла обратно
  it("собирает rpm-имя из имени и версии", () => {
    expect(artifactFileName("nginx", "1.24.0-1.el9", "rpm")).toBe("nginx-1.24.0-1.el9.rpm");
    expect(artifactFileName("nginx", "1.24.0", "rpm")).toBe("nginx-1.24.0.rpm");
  });

  it("собирает deb-имя из имени и версии", () => {
    expect(artifactFileName("nginx", "1.24.0", "deb")).toBe("nginx_1.24.0.deb");
  });
});