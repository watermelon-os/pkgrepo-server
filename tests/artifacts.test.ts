import { describe, it, expect } from "vitest";
import {
  parseArtifactName,
  artifactFileName,
  defaultArtifactTemplates,
} from "../src/artifacts.js";

const rpmTemplate = defaultArtifactTemplates.rpm!;
const debTemplate = defaultArtifactTemplates.deb!;

describe("artifact name parsing (fallback)", () => {
  // PRS-04. Парсер имени файла — фолбэк, когда утилита недоступна/не разобрала
  it("разбирает rpm: имя-версия-релиз.архитектура", () => {
    const parsed = parseArtifactName("bash-5.2.37-2.x86_64.rpm", rpmTemplate);
    expect(parsed).toEqual({ name: "bash", version: "5.2.37-2.x86_64" });
  });

  // PRS-02. rpm с релизом-ос
  it("разбирает rpm с релизом-ос", () => {
    const parsed = parseArtifactName("nginx-1.24.0-1.el9.x86_64.rpm", rpmTemplate);
    expect(parsed).toEqual({ name: "nginx", version: "1.24.0-1.el9.x86_64" });
  });

  // PRS-03. deb: имя_версия_архитектура
  it("разбирает deb без релиза", () => {
    const parsed = parseArtifactName("nginx_1.24.0_amd64.deb", debTemplate);
    expect(parsed).toEqual({ name: "nginx", version: "1.24.0_amd64" });
  });

  it("разбирает deb с релизом в версии", () => {
    const parsed = parseArtifactName("bash_5.2.37-2_amd64.deb", debTemplate);
    expect(parsed).toEqual({ name: "bash", version: "5.2.37-2_amd64" });
  });

  it("разбирает deb с дефисами в имени", () => {
    const parsed = parseArtifactName("python3-pip_24.0_amd64.deb", debTemplate);
    expect(parsed).toEqual({ name: "python3-pip", version: "24.0_amd64" });
  });

  // PRS-04. Неразбираемое имя (фолбэк-парсер)
  it("возвращает undefined для неразбираемого rpm", () => {
    expect(parseArtifactName("README.txt", rpmTemplate)).toBeUndefined();
    expect(parseArtifactName("nginx.rpm", rpmTemplate)).toBeUndefined();
  });

  it("возвращает undefined для неразбираемого deb", () => {
    expect(parseArtifactName("README.txt", debTemplate)).toBeUndefined();
    expect(parseArtifactName("nginx.deb", debTemplate)).toBeUndefined();
  });

  // PRS-06. Сборка имени файла обратно
  it("собирает rpm-имя из имени и версии", () => {
    expect(artifactFileName("bash", "5.2.37-2.x86_64", rpmTemplate)).toBe("bash-5.2.37-2.x86_64.rpm");
    expect(artifactFileName("nginx", "1.24.0-1.el9.x86_64", rpmTemplate)).toBe(
      "nginx-1.24.0-1.el9.x86_64.rpm",
    );
  });

  it("собирает deb-имя из имени и версии", () => {
    expect(artifactFileName("nginx", "1.24.0_amd64", debTemplate)).toBe("nginx_1.24.0_amd64.deb");
  });
});
