import { htmlToText, sourceLocation } from "@tallo/catalog";
import type {
  CollectContext,
  HttpResponse,
  JobLocation,
  Json,
  JsonObject,
  Listing,
  SourceConfig,
  WorkMode,
} from "@tallo/contracts";
import { arr, isObject, obj, str } from "@tallo/contracts";

/**
 * Bound entity work across every value in one XML response. Escaped HTML in a large feed (every `&lt;` and `&amp;`
 * in thousands of descriptions) is a legitimate expansion count well over 100k, so the cap is 1M: still a hard stop
 * for an entity bomb, and the response size cap bounds real feeds long before it.
 */
export const XML_ENTITIES = { maxTotalExpansions: 1_000_000 };

/** A source label embedded inside generated HTML is text, never markup. */
export const htmlText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The source answered, but not in the shape we know. Aborts the run; never implies closure. */
export class SchemaError extends Error {}

export function rows(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value) || !value.every(isObject))
    throw new SchemaError(`Expected array of objects at ${label}`);
  return value as JsonObject[];
}

/**
 * GET a whole-board listing, conditional on the stored validator when there is one. Only for hosts
 * verified to answer `If-None-Match` with 304 (see docs/platforms.md); the answer is either the full
 * listing (200) or "unchanged" (304, no body).
 */
export function conditional(ctx: CollectContext, url: string): Promise<HttpResponse> {
  return ctx.http.getJson(url, {
    ...(ctx.validator ? { headers: { "if-none-match": ctx.validator } } : {}),
    okStatuses: [304],
  });
}

/** The listing result for a 304: the board is as it was at the last complete run; nothing is yielded. */
export function notModified(ctx: CollectContext): Listing {
  if (!ctx.validator)
    throw new SchemaError("304 answered a listing request that sent no validator");
  return {
    complete: true,
    emptyIsAuthoritative: false,
    notModified: true,
    validator: ctx.validator,
  };
}

export function requireKey(source: SourceConfig, pattern = /^[A-Za-z0-9][\w.-]*$/): void {
  if (!pattern.test(source.key)) throw new Error(`Invalid ${source.platform} key: ${source.key}`);
}

export const isoFromMs = (ms: unknown): string | undefined =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;

/**
 * The work mode a source states in its own words. Any word that names a mode counts, with precedence
 * hybrid > remote > onsite, so "Hybrid Remote" and "Hybrid (Travel-Required)" read as hybrid. A value
 * that names no mode ("Flexible", "Office") stays undefined.
 */
const MODE_WORDS: [WorkMode, RegExp][] = [
  ["hybrid", /\bhybrid\b/],
  ["remote", /\bremote\b/],
  ["onsite", /\b(onsite|on site|inoffice|in office|inperson|in person)\b/],
];
const NEGATION = /\b(non|not|no)\b/;

/**
 * The work mode a source states, when exactly one mode family appears and nothing negates it.
 * "Hybrid (Travel-Required)" states one mode (hybrid) with other words. "Remote or On-Site",
 * "Hybrid Remote", "Non-Remote" or "Not remote" state either several modes or a negation, so the
 * source does not state one mode and the result is undefined.
 */
export function workModeOf(value: unknown): WorkMode | undefined {
  const words = (str(value) ?? "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
  if (!words || NEGATION.test(words)) return undefined;
  const stated = MODE_WORDS.filter(([, pattern]) => pattern.test(words)).map(([mode]) => mode);
  return stated.length === 1 ? stated[0] : undefined;
}

/** Description text from HTML fragments, in order. Fragments may be missing. */
export function describe(...html: unknown[]): string {
  return htmlToText(
    html
      .map((h) => str(h))
      .filter(Boolean)
      .join("\n"),
  );
}

/**
 * Distinct places the source listed, split at its own `;` and `|` separators. Structure comes only from
 * the source's fields (`hints`). The first place is primary.
 */
export function locations(
  entries: { text: unknown; hints?: Partial<JobLocation> }[],
): JobLocation[] {
  const seen = new Set<string>();
  const out: JobLocation[] = [];
  for (const { text, hints } of entries) {
    for (const part of (str(text) ?? "").split(/\s*[;|]\s*/)) {
      const key = part.toLowerCase();
      if (!part || seen.has(key)) continue;
      seen.add(key);
      out.push(sourceLocation(part, { ...hints, ...(out.length === 0 ? { primary: true } : {}) }));
    }
  }
  return out;
}

/** The entries whose value is neither undefined nor null; `extras` must stay JSON. */
export const definedOnly = (fields: Record<string, Json | undefined>): JsonObject =>
  Object.fromEntries(Object.entries(fields).filter((e): e is [string, Json] => e[1] != null));

/** The non-empty strings of an array, in order. */
export const strings = (value: unknown): string[] =>
  arr(value)
    .map((entry) => str(entry))
    .filter((entry): entry is string => entry !== undefined);

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
  Object.fromEntries(
    keys.filter((k) => obj(value)[k] != null).map((k) => [k, obj(value)[k] as Json]),
  );

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
