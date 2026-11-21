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

/** Bound entity work across every value in one XML response. */
export const XML_ENTITIES = { maxTotalExpansions: 100_000 };

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

export function workModeOf(value: unknown): WorkMode | undefined {
  const v = str(value)
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  if (v === "remote") return "remote";
  if (v === "hybrid") return "hybrid";
  if (v === "onsite" || v === "inoffice" || v === "inperson") return "onsite";
  return undefined;
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
