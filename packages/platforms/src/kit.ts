import { arr, isObject, obj, str } from "@tallo/contracts";
import type { Json, JobLocation, JsonObject, PayInterval, SourceConfig, WorkMode } from "@tallo/contracts";
import { htmlToText, parseLocation } from "@tallo/catalog";

/** The source answered, but not in the shape we know. Aborts the run; never implies closure. */
export class SchemaError extends Error {}

export function rows(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value) || !value.every(isObject)) throw new SchemaError(`Expected array of objects at ${label}`);
  return value as JsonObject[];
}

export function requireKey(source: SourceConfig, pattern = /^[A-Za-z0-9][\w.-]*$/): void {
  if (!pattern.test(source.key)) throw new Error(`Invalid ${source.platform} key: ${source.key}`);
}

export const isoFromMs = (ms: unknown): string | undefined =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;

export function workModeOf(value: unknown): WorkMode | undefined {
  const v = str(value)?.toLowerCase().replace(/[^a-z]/g, "");
  if (v === "remote") return "remote";
  if (v === "hybrid") return "hybrid";
  if (v === "onsite" || v === "inoffice" || v === "inperson") return "onsite";
  return undefined;
}

/** Pay interval for sources that omit it: annual salaries are large, hourly wages small. */
export function guessInterval(amount: number): PayInterval {
  return amount >= 20000 ? "year" : amount > 0 && amount < 500 ? "hour" : "unknown";
}

/** Description text from HTML fragments, in order. Fragments may be missing. */
export function describe(...html: unknown[]): string {
  return htmlToText(html.map((h) => str(h)).filter(Boolean).join("\n"));
}

/** Distinct locations from free text; the first is primary. */
export function locations(entries: { text: unknown; hints?: Partial<JobLocation> }[]): JobLocation[] {
  const seen = new Set<string>();
  const out: JobLocation[] = [];
  for (const { text, hints } of entries) {
    for (const part of (str(text) ?? "").split(/\s*[;|]\s*/)) {
      const key = part.toLowerCase();
      if (!part || seen.has(key)) continue;
      seen.add(key);
      out.push(parseLocation(part, { ...hints, ...(out.length === 0 ? { primary: true } : {}) }));
    }
  }
  return out;
}

/** `{name: value}` view of an array of `{name|label, value}` entries. */
export function pairs(list: unknown, nameKey: string, valueKey: string): JsonObject {
  const out: JsonObject = {};
  for (const item of arr(list)) {
    const name = str(obj(item)[nameKey]);
    const value = obj(item)[valueKey];
    if (name && value !== undefined && value !== null) out[name] = value;
  }
  return out;
}

export const pick = (value: Json | undefined, ...keys: string[]): JsonObject =>
  Object.fromEntries(keys.filter((k) => obj(value)[k] != null).map((k) => [k, obj(value)[k] as Json]));

/**
 * Field reader over layered payloads (first non-null wins). Reads stay explicit, so
 * `tallo verify` can tell which source fields a mapper really uses.
 */
export const lookup =
  (...layers: unknown[]) =>
  (key: string): Json | undefined => {
    for (const layer of layers) {
      const value = obj(layer)[key];
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  };
