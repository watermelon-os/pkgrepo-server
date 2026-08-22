/**
 * Разбор содержимого спек-файла (rpm spec): теги Name/Version/Release.
 * Результат — только имя и версия; релиз входит в version-строку
 * (`версия-релиз`), отдельным полем не становится.
 *
 * «Тупой» парсер по содержимому: инструменты для обработки спеков
 * (`rpmspec` и т.п.) не требуются; значения с макросами %{...} не
 * разбираются — такой спек считается невалидным (NM-05).
 */

export interface ParsedSpec {
  name: string;
  version: string;
}

const tagRe = /^(Name|Version|Release):\s*(\S+)\s*$/i;
const valueRe = /^[a-zA-Z0-9._+~-]+$/;

/** Разбор спека по тегам; undefined, если имя или версия не извлекаются. */
export function parseSpecContent(text: string): ParsedSpec | undefined {
  let name: string | undefined;
  let version: string | undefined;
  let release: string | undefined;
  for (const line of text.split("\n")) {
    const match = tagRe.exec(line.trim());
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!;
    if (!valueRe.test(value)) return undefined;
    if (key === "name" && name === undefined) name = value;
    if (key === "version" && version === undefined) version = value;
    if (key === "release" && release === undefined) release = value;
  }
  if (!name || !version) return undefined;
  return { name, version: release ? `${version}-${release}` : version };
}
