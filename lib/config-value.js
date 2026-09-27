const MAX_DIAGNOSTIC_SNIPPET = 120;
const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isKebabCaseName(name) {
  return name.length > 0 && name.length <= 128 && KEBAB_NAME.test(name);
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function clipDiagnostic(text) {
  if (text.length <= MAX_DIAGNOSTIC_SNIPPET) return text;
  return `${text.slice(0, MAX_DIAGNOSTIC_SNIPPET)}…`;
}

export function readOwnDataProperty(object, key) {
  try {
    if (!Object.hasOwn(object, key)) return { ok: false, reason: "missing" };
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || "get" in descriptor || "set" in descriptor || !("value" in descriptor)) {
      return { ok: false, reason: "not a data property" };
    }
    return { ok: true, value: descriptor.value };
  } catch (error) {
    let message = "unprintable error";
    try {
      message = error instanceof Error ? error.message : String(error);
    } catch {
      // Keep bounded fallback.
    }
    return { ok: false, reason: `property access failed: ${clipDiagnostic(message)}` };
  }
}

export { MAX_DIAGNOSTIC_SNIPPET };
