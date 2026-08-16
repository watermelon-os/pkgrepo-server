/**
 * Парсер имени файла по шаблону пакетной системы — фолбэк для разбора
 * артефактов, когда утилита пакетной системы недоступна или не смогла
 * разобрать файл (см. repoAdapter.inspectPackage).
 *
 * Результат разбора — только имя и версия: релиз и архитектура входят в
 * version-строку, отдельными полями не становятся.
 */

export interface ArtifactTemplate {
  type: string;
  extension: string;
  /** Разделитель между именем и версией в имени файла. */
  nameSeparator: string;
}

export interface ParsedArtifact {
  name: string;
  version: string;
}

export const defaultArtifactTemplates: Record<string, ArtifactTemplate> = {
  rpm: { type: "rpm", extension: ".rpm", nameSeparator: "-" },
  deb: { type: "deb", extension: ".deb", nameSeparator: "_" },
  pacman: { type: "pacman", extension: ".pkg.tar.zst", nameSeparator: "-" },
};

const packagePart = /^[a-zA-Z0-9._+~-]+$/;

function validPart(value: string): boolean {
  return value.length > 0 && packagePart.test(value);
}

/**
 * rpm/pacman: имя-версия-релиз.архитектура — версией становится
 * `version-release.arch` (rpm) или `version-release-arch` (pacman).
 */
function parseHyphenDotted(
  base: string,
  archSeparator: string,
): ParsedArtifact | undefined {
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const arch = base.slice(dot + 1);
  const rest = base.slice(0, dot);
  const dash1 = rest.lastIndexOf("-");
  if (dash1 <= 0) return undefined;
  const release = rest.slice(dash1 + 1);
  const rest2 = rest.slice(0, dash1);
  const dash2 = rest2.lastIndexOf("-");
  if (dash2 <= 0) return undefined;
  const versionPart = rest2.slice(dash2 + 1);
  const name = rest2.slice(0, dash2);
  const version = `${versionPart}-${release}${archSeparator}${arch}`;
  if (!validPart(name) || !validPart(version) || !validPart(versionPart) || !validPart(release) || !validPart(arch)) {
    return undefined;
  }
  return { name, version };
}

/** deb: имя_версия_архитектура — версией становится `version_arch`. */
function parseUnderscored(base: string): ParsedArtifact | undefined {
  const us = base.lastIndexOf("_");
  if (us <= 0) return undefined;
  const arch = base.slice(us + 1);
  const rest = base.slice(0, us);
  const us2 = rest.lastIndexOf("_");
  if (us2 <= 0) return undefined;
  const versionPart = rest.slice(us2 + 1);
  const name = rest.slice(0, us2);
  const version = `${versionPart}_${arch}`;
  if (!validPart(name) || !validPart(version) || !validPart(versionPart) || !validPart(arch)) {
    return undefined;
  }
  return { name, version };
}

/** Разбор имени файла по шаблону; undefined, если файл не соответствует. */
export function parseArtifactName(
  fileName: string,
  template: ArtifactTemplate,
): ParsedArtifact | undefined {
  if (!fileName.endsWith(template.extension)) return undefined;
  const base = fileName.slice(0, -template.extension.length);
  switch (template.type) {
    case "rpm":
      return parseHyphenDotted(base, ".");
    case "pacman":
      return parseHyphenDotted(base, "-");
    case "deb":
      return parseUnderscored(base);
    default:
      return undefined;
  }
}

/** Сборка имени файла из имени и версии (версия содержит все компоненты). */
export function artifactFileName(
  name: string,
  version: string,
  template: ArtifactTemplate,
): string {
  return `${name}${template.nameSeparator}${version}${template.extension}`;
}