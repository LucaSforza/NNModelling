/** Parameter normalization used by the v2 evaluator without executing Python. */

export type NormalizedParameterValue =
  | { readonly status: "unset"; readonly raw: unknown }
  | { readonly status: "invalid"; readonly raw: unknown; readonly reason: string }
  | { readonly status: "resolved"; readonly raw: unknown; readonly value: number | boolean | string | readonly number[] };

const unsetStrings = new Set(["", "undefined", "none", "null"]);

export function normalizeParameterValue(raw: unknown, declaredType: string): NormalizedParameterValue {
  if (raw === undefined || raw === null || (typeof raw === "string" && unsetStrings.has(raw.trim().toLowerCase()))) {
    return { status: "unset", raw };
  }

  const types = declaredType.toLowerCase().split("|").map((type) => type.trim());
  const attempts = types.map((type) => normalizeAs(raw, type));
  return attempts.find((attempt) => attempt.status === "resolved")
    ?? { status: "invalid", raw, reason: `expected ${declaredType}` };
}

function normalizeAs(raw: unknown, type: string): NormalizedParameterValue {
  if (type === "int" || type === "integer") return normalizeInteger(raw);
  if (type === "float" || type === "number") return normalizeNumber(raw);
  if (type === "bool" || type === "boolean") return normalizeBoolean(raw);
  if (type === "tuple" || type === "list" || type === "shape" || type === "int[]") return normalizeIntegerList(raw);
  if (type === "str" || type === "string") return typeof raw === "string"
    ? { status: "resolved", raw, value: raw }
    : { status: "invalid", raw, reason: "expected a string" };
  return { status: "invalid", raw, reason: `unsupported parameter type '${type}'` };
}

function normalizeInteger(raw: unknown): NormalizedParameterValue {
  const text = String(raw).trim();
  if (!/^[+-]?\d+$/.test(text)) return { status: "invalid", raw, reason: "expected an integer" };
  const value = Number(text);
  return Number.isSafeInteger(value)
    ? { status: "resolved", raw, value }
    : { status: "invalid", raw, reason: "integer is outside the safe range" };
}

function normalizeNumber(raw: unknown): NormalizedParameterValue {
  const text = String(raw).trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return { status: "invalid", raw, reason: "expected a finite number" };
  const value = Number(text);
  return Number.isFinite(value) ? { status: "resolved", raw, value } : { status: "invalid", raw, reason: "expected a finite number" };
}

function normalizeBoolean(raw: unknown): NormalizedParameterValue {
  if (raw === true || raw === false) return { status: "resolved", raw, value: raw };
  if (typeof raw === "string" && /^(true|false)$/i.test(raw.trim())) {
    return { status: "resolved", raw, value: raw.trim().toLowerCase() === "true" };
  }
  return { status: "invalid", raw, reason: "expected true or false" };
}

function normalizeIntegerList(raw: unknown): NormalizedParameterValue {
  const items = Array.isArray(raw) ? raw : parseDelimitedIntegerList(raw);
  if (items.length === 0) return { status: "invalid", raw, reason: "expected a non-empty integer list" };
  const values: number[] = [];
  for (const item of items) {
    const normalized = normalizeInteger(item);
    if (normalized.status !== "resolved" || typeof normalized.value !== "number") {
      return { status: "invalid", raw, reason: "expected an integer list" };
    }
    values.push(normalized.value);
  }
  return { status: "resolved", raw, value: values };
}

function parseDelimitedIntegerList(raw: unknown): unknown[] {
  if (typeof raw !== "string") return [];
  const text = raw.trim();
  const delimiters = (text.startsWith("(") && text.endsWith(")")) || (text.startsWith("[") && text.endsWith("]"));
  return delimiters ? text.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean) : [];
}
