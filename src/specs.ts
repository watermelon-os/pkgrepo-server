/**
 * Разбор содержимого спек-файла (rpm spec): теги Name/Version/Release.
 * Результат — только имя и версия; релиз входит в version-строку
 * (`версия-релиз`), отдельным полем не становится.
 *
 * Структурная проверка без rpmspec: простые макросы RPM раскрываются
 * локально — %{name}, %{version}, макросы из %global/%define, условные
 * %{?dist} (не определен → пустая строка). Нераскрываемые %{...} и
 * shell-подстановки %(...) считаются невалидными: их значение знает
 * только сборочное окружение (NM-05). Оконательную проверку делает
 * rpmbuild на стороне сборки.
 */

export interface ParsedSpec {
  name: string;
  version: string;
}

const tagRe = /^(Name|Version|Release):\s*(\S+)\s*$/i;
const defineRe = /^%(?:global|define)\s+(\w+)(?:\(\S+\))?\s+(.+)$/;
const valueRe = /^[a-zA-Z0-9._+~-]+$/;

class SpecParseError extends Error {}

/**
 * Раскрытие макросов в значении тега: %{name}/%{version} и макросы
 * пользователя, %{?x} → значение или "" если не определен, %{x} без
 * определения → ошибка. Повторяем до стабилизации (вложенные макросы).
 */
function expandMacros(value: string, macros: Map<string, string>): string {
  let result = value;
  for (let pass = 0; pass < 16; pass++) {
    let changed = false;
    let next = result.replace(/%\(([^)]*)\)/g, (_m, cmd: string) => {
      throw new SpecParseError(`shell expansion "%(${cmd})" is not supported`);
    });
    if (next !== result) changed = true;
    result = next;
    next = result.replace(/%\{(\??)(\w+)\}/g, (_m, cond: string, name: string) => {
      const v = macros.get(name);
      if (v !== undefined) return v;
      if (cond) return "";
      throw new SpecParseError(`unresolvable macro %{${name}}`);
    });
    if (next !== result) changed = true;
    result = next;
    if (!changed) break;
  }
  return result;
}

type TagValues = { name: string; version: string; release?: string };

function extractTags(text: string): { tags?: TagValues; error?: string } {
  const macros = new Map<string, string>();
  let name: string | undefined;
  let version: string | undefined;
  let release: string | undefined;

  // Первый проход: собираем %global/%define, чтобы теги могли их использовать.
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const def = defineRe.exec(trimmed);
    if (!def) continue;
    try {
      macros.set(def[1]!, expandMacros(def[2]!.trim(), macros));
    } catch {
      // Нераскрываемое определение просто недоступно для подстановки.
    }
  }

  for (const line of text.split("\n")) {
    const match = tagRe.exec(line.trim());
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const raw = match[2]!;
    let value: string;
    try {
      value = expandMacros(raw, macros);
    } catch (err) {
      if (!(err instanceof SpecParseError)) throw err;
      return { error: `tag ${match[1]} has unresolvable value "${raw}" (${err.message})` };
    }
    if (!valueRe.test(value)) {
      return {
        error: `tag ${match[1]} has invalid value "${value}" (allowed: [a-zA-Z0-9._+~-])`,
      };
    }
    if (key === "name" && name === undefined) name = value;
    if (key === "version" && version === undefined) version = value;
    if (key === "release" && release === undefined) release = value;
  }

  if (!name || !version) {
    if (!name && !version) return { error: "no Name/Version tags found" };
    if (!name) return { error: "missing Name tag" };
    return { error: "missing Version tag" };
  }
  return { tags: { name, version, release } };
}

/** Разбор спека по тегам; undefined, если имя или версия не извлекаются. */
export function parseSpecContent(text: string): ParsedSpec | undefined {
  const { tags } = extractTags(text);
  if (!tags) return undefined;
  return {
    name: tags.name,
    version: tags.release ? `${tags.version}-${tags.release}` : tags.version,
  };
}

/**
 * Причина, по которой спек не разбирается; для диагностики отказов
 * загрузки (invalid_spec). Вызывать только когда parseSpecContent
 * вернул undefined.
 */
export function specParseErrorReason(text: string): string {
  return extractTags(text).error ?? "unknown parse failure";
}
