export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Safe accessors for untrusted source JSON. They never throw. */
export function obj(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

export function arr(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

export function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** Numeric or string identifiers become strings. */
export function id(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : str(value);
}

/** Walk a path of keys/indexes; undefined as soon as anything is missing. */
export function at(value: unknown, ...keys: (string | number)[]): Json | undefined {
  let cur: unknown = value;
  for (const key of keys) {
    if (typeof key === "number") cur = Array.isArray(cur) ? cur[key] : undefined;
    else cur = isObject(cur) ? cur[key] : undefined;
    if (cur === undefined) return undefined;
  }
  return cur as Json | undefined;
}
