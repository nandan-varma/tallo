import { z } from "zod";
import { moneySchema } from "./job.ts";
import {
  jobHitSchema,
  SEARCH_DEFAULT_SORT,
  SEARCH_RESULT_CAP,
  type SearchSort,
  searchSortSchema,
} from "./search.ts";

/**
 * The public read API. No auth, GET only, JSON. The web Worker serves these under `tallo.nandan.fyi` through an
 * allowlist; the API implements them. Every limit an LLM reads about is defined here, once, and `llms.txt` and
 * `/v1/openapi.json` are generated from these schemas.
 */

/** The public origin, for the examples in llms.txt. Code never builds links from it. */
export const PUBLIC_ORIGIN = "https://tallo.nandan.fyi";

/** The response shape version. Additive fields do not bump it; a semantic change to an existing field does. */
export const PUBLIC_API_VERSION = "2" as const;

/**
 * The only paths the public may read, GET only. `:id` is a posting id. The web Worker forwards exactly these to the
 * API and answers 404 for everything else under `/v1`, admin and ingest included.
 */
export const PUBLIC_PATHS = [
  "/v1/search",
  "/v1/jobs/:id",
  "/v1/jobs/:id/description",
  "/v1/companies",
  "/v1/titles",
  "/v1/openapi.json",
] as const;

/** A posting id in a path: a positive whole number with no leading zero, at most 16 digits. */
export const POSTING_ID_SOURCE = "[1-9]\\d{0,15}";

/** Longest path plus query the public API accepts, in characters. Longer is answered 414 before any query runs. */
export const PUBLIC_MAX_URL_CHARS = 2048;

/** Requests per minute from one address. The web Worker's rate limiting binding is configured to match (wrangler.jsonc). */
export const PUBLIC_RATE_PER_MINUTE = 60;

export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 25;
/** Discovery endpoints: at most this many names per answer, and a prefix at least this long. */
export const DISCOVERY_MAX_RESULTS = 50;
export const DISCOVERY_MIN_PREFIX = 1;
export const DISCOVERY_MAX_PREFIX = 40;

/** Search answers depend only on the query and the catalog's last refresh: cache them for minutes. */
export const SEARCH_CACHE_CONTROL = "public, max-age=60, s-maxage=300";
/** A posting changes rarely: cache its facts and description for an hour at the edge. */
export const JOB_CACHE_CONTROL = "public, max-age=300, s-maxage=3600";

/**
 * Stable negative answers for one posting id, by state (see `jobState`). A closed posting or one from a board that stopped
 * listing can come back only through a new listing, so a minute of cache is enough to absorb repeat asks. An id with no
 * row is stable for longer. Parameter errors are never cached (`no-store`).
 */
export const NEGATIVE_CACHE_CONTROL = {
  closed: "public, max-age=60, s-maxage=60",
  source_hidden: "public, max-age=60, s-maxage=60",
  unknown: "public, max-age=3600, s-maxage=3600",
} as const;

/**
 * The response header the API uses to report what an answer cost the database (`statements`, `rows_read`,
 * `rows_written`, `rows_returned`, JSON). Only the public proxy reads it: it logs the line and strips the header before
 * anything is cached or returned to a caller.
 */
export const PUBLIC_COST_HEADER = "x-tallo-cost";

/** A value must contain a letter or a digit: punctuation alone matches nothing and explains nothing. */
const hasWord = (value: string) => /[\p{L}\p{N}]/u.test(value);

const phrase = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, `values must be ${min} to ${max} characters`)
    .max(max, `values must be ${min} to ${max} characters`)
    .refine(hasWord, "values must contain a letter or a digit");

/**
 * The parsed query of `GET /v1/search`. `title`, `company` and `location` repeat in the URL; the others are single.
 * Each field's description is what llms.txt says about it.
 */
export const publicSearchSchema = z.object({
  title: z
    .array(phrase(2, 80))
    .max(8, "takes at most 8 values")
    .default([])
    .describe(
      "Optional when company is given, otherwise required. Repeat 1 to 8 times, one job title each, 2 to 80 characters. Use specific titles such as backend engineer. Repeated values are alternatives: adding one widens the set, it does not filter.",
    ),
  company: z
    .array(phrase(2, 80))
    .max(4, "takes at most 4 values")
    .default([])
    .describe(
      "Optional. Repeat up to 4 times with company names the person named, 2 to 80 characters each. Matched on the company name and ANDed with the titles. Repeated values are alternatives. Give a company when you do not have a specific title.",
    ),
  location: z
    .array(phrase(2, 60))
    .max(8, "takes at most 8 values")
    .default([])
    .describe(
      "Optional. Repeat up to 8 times, 2 to 60 characters each, in the person's own words (NYC, Bay Area, Seattle, remote). The server expands reviewed aliases and returns what it matched in expandedLocations. The reviewed remote aliases (remote, anywhere, work from home, wfh, home based, distributed, telecommute) are a work-mode filter: remote postings are ORed with the place matches, not searched for as text. Repeated values are alternatives, except that they still narrow within the company and title match.",
    ),
  country: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z]{2}$/, "each value must be two letters, an ISO 3166-1 alpha-2 code")
        .transform((value) => value.toUpperCase()),
    )
    .max(8, "takes at most 8 values")
    .default([])
    .describe(
      "Optional. Repeat up to 8 times with two-letter ISO 3166-1 alpha-2 country codes (case-insensitive, stored uppercase: US, CA, DE). Only postings whose primary location states one of these countries are returned. Rows where the source stated no country code are excluded, so coverage is partial; the code is never inferred from location text.",
    ),
  postedWithin: z.coerce
    .number({ error: "must be a whole number of days" })
    .int("must be a whole number of days")
    .min(1, "must be at least 1 day")
    .max(365, "must be at most 365 days")
    .optional()
    .describe(
      "Optional. Whole days from 1 to 365. Only postings whose sort date is within this many days are returned. The sort date is the source's posted date, or when Tallo first saw the posting if the source stated none: the same value sort=recent orders by. It is never inferred from text.",
    ),
  sort: searchSortSchema
    .default(SEARCH_DEFAULT_SORT)
    .describe(
      `Optional. Result order. relevance (default) is best match first. recent is newest first by the source's posted date, else when Tallo first saw the posting; posted is the same order but only postings where the source stated a date; added is most recently added to the catalog first. recent and posted list every open location separately; relevance collapses one company, title and requisition. Dates are source-stated, never guessed.`,
    ),
  limit: z.coerce
    .number({ error: "must be a whole number" })
    .int("must be a whole number")
    .min(1, "must be at least 1")
    .max(SEARCH_MAX_LIMIT, `must be at most ${SEARCH_MAX_LIMIT}`)
    .default(SEARCH_DEFAULT_LIMIT)
    .describe(
      `Optional. A whole number from 1 to ${SEARCH_MAX_LIMIT}. Default ${SEARCH_DEFAULT_LIMIT}.`,
    ),
  cursor: z
    .string()
    .max(100, "is not a cursor from this API")
    .optional()
    .describe(
      "Optional. The next value from the previous response, unchanged, with the same title, company, location, country, postedWithin and sort values. It is opaque; do not build or edit one.",
    ),
});

/** The parsed query of `GET /v1/jobs/:id/description`. */
export const publicDescriptionSchema = z.object({
  offset: z.coerce
    .number({ error: "must be a whole number" })
    .int("must be a whole number")
    .min(0, "must be 0 or more")
    .default(0)
    .describe(
      "Optional. Character offset into the description, from 0. Use descriptionNext from the previous chunk.",
    ),
  limit: z.coerce
    .number({ error: "must be a whole number" })
    .int("must be a whole number")
    .min(1, "must be at least 1")
    .optional()
    .describe(
      "Optional. Characters to return, 1 or more. Omit it to get everything from offset to the end.",
    ),
});

/** The error body of every public 4xx/410: what was wrong, and how to fix the request. */
export const publicErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), hint: z.string() }),
});
export type PublicError = z.infer<typeof publicErrorSchema>;

export const publicError = (code: string, message: string, hint: string): PublicError => ({
  error: { code, message, hint },
});

/** `GET /v1/search`.
 *
 * `next` is the cursor for the next page, or null on the last. `hasMore` repeats that in a form a caller can branch
 * on. `capped` means the 300-result cap stopped this list; it does not assert that more results exist.
 */
export const publicSearchPageSchema = z.object({
  apiVersion: z.literal(PUBLIC_API_VERSION),
  results: z.array(jobHitSchema),
  count: z.number().int().nonnegative(),
  next: z.string().nullable(),
  hasMore: z.boolean(),
  capped: z.boolean(),
  expandedLocations: z.array(z.string()),
  remote: z.boolean(),
  asOf: z.string(),
  note: z.string(),
});
export type PublicSearchPage = z.infer<typeof publicSearchPageSchema>;

/** One open location (a `dup_of` sibling) of a posting. Includes the posting itself. */
export const publicVariantSchema = z.object({
  id: z.string(),
  location: z.string().nullable(),
  workMode: z.enum(["remote", "hybrid", "onsite"]).nullable(),
  postedAt: z.string().nullable(),
  applyUrl: z.string().nullable(),
});

/** `GET /v1/jobs/:id`. */
export const publicJobSchema = z.object({
  apiVersion: z.literal(PUBLIC_API_VERSION),
  id: z.string(),
  title: z.string(),
  company: z.string(),
  location: z
    .string()
    .nullable()
    .describe(
      "The place text the source gave, else its city, region and country code; null when the source stated no place. Never inferred from other text.",
    ),
  workMode: z
    .enum(["remote", "hybrid", "onsite"])
    .nullable()
    .describe(
      "The work mode the source stated: remote, hybrid, onsite, or null when it stated none. Never inferred from location text.",
    ),
  pay: z
    .string()
    .nullable()
    .describe(
      "The source's stated base pay with its own interval, or null when the source stated none. Never estimated or converted.",
    ),
  compensation: z
    .array(moneySchema)
    .describe(
      "The source's stated pay bands verbatim, never converted or annualized. Empty when the source stated none; it is not derived from pay text.",
    ),
  postedAt: z
    .string()
    .nullable()
    .describe(
      "The posted date the source states, as YYYY-MM-DD, or null when the source stated none. Some large feeds omit it. It is never guessed.",
    ),
  department: z
    .string()
    .nullable()
    .describe(
      "The source's own department label, or null when it stated none. Not a normalized category.",
    ),
  employmentType: z
    .string()
    .nullable()
    .describe(
      "The source's own employment type label, or null when it stated none. Not a normalized category.",
    ),
  countryCode: z
    .string()
    .length(2)
    .nullable()
    .describe(
      "ISO 3166-1 alpha-2 for the primary location, or null when the source stated no country code. Coverage is partial (some large boards state only free text), and it is never inferred from location text.",
    ),
  applyUrl: z.string().nullable(),
  sourceLastListedAt: z
    .string()
    .nullable()
    .describe(
      "ISO 8601 UTC time of the board's last complete listing, or null when it has never listed. This is the board's freshness, not a per-posting sighting or proof that this posting was in that listing.",
    ),
  variants: z.array(publicVariantSchema),
  descriptionChars: z.number().int().nonnegative().nullable(),
  description: z.string().nullable(),
  descriptionNext: z.number().int().nonnegative().nullable(),
});
export type PublicJob = z.infer<typeof publicJobSchema>;

/** `GET /v1/jobs/:id/description`. */
export const publicDescriptionResponseSchema = z.object({
  apiVersion: z.literal(PUBLIC_API_VERSION),
  id: z.string(),
  offset: z.number().int().nonnegative(),
  descriptionChars: z.number().int().nonnegative(),
  description: z.string(),
  descriptionNext: z.number().int().nonnegative().nullable(),
});
export type PublicDescriptionResponse = z.infer<typeof publicDescriptionResponseSchema>;

/** `GET /v1/companies`: the company names and slugs the catalog holds, for discovery. */
export const publicCompanyListSchema = z.object({
  apiVersion: z.literal(PUBLIC_API_VERSION),
  asOf: z.string(),
  count: z.number().int().nonnegative(),
  companies: z.array(z.object({ name: z.string(), slug: z.string() })),
  /** True when more names match the prefix than this answer returned. */
  truncated: z.boolean(),
});
export type PublicCompanyList = z.infer<typeof publicCompanyListSchema>;

/** `GET /v1/titles`: title words the catalog has observed, for discovery. */
export const publicTitleListSchema = z.object({
  apiVersion: z.literal(PUBLIC_API_VERSION),
  asOf: z.string(),
  count: z.number().int().nonnegative(),
  titles: z.array(z.string()),
  truncated: z.boolean(),
});
export type PublicTitleList = z.infer<typeof publicTitleListSchema>;

/** The discovery query both endpoints take. */
export const publicDiscoverySchema = z.object({
  prefix: z
    .string()
    .trim()
    .min(
      DISCOVERY_MIN_PREFIX,
      `must be ${DISCOVERY_MIN_PREFIX} to ${DISCOVERY_MAX_PREFIX} characters`,
    )
    .max(
      DISCOVERY_MAX_PREFIX,
      `must be ${DISCOVERY_MIN_PREFIX} to ${DISCOVERY_MAX_PREFIX} characters`,
    )
    .refine(hasWord, "must contain a letter or a digit")
    .optional()
    .describe(
      `Optional. Only names starting with this text (${DISCOVERY_MIN_PREFIX} to ${DISCOVERY_MAX_PREFIX} characters). Omit to list from the beginning.`,
    ),
  limit: z.coerce
    .number({ error: "must be a whole number" })
    .int("must be a whole number")
    .min(1, "must be at least 1")
    .max(DISCOVERY_MAX_RESULTS, `must be at most ${DISCOVERY_MAX_RESULTS}`)
    .default(DISCOVERY_MAX_RESULTS)
    .describe(
      `Optional. Return at most ${DISCOVERY_MAX_RESULTS} names. Default ${DISCOVERY_MAX_RESULTS}.`,
    ),
});
export type PublicDiscoveryQuery = z.infer<typeof publicDiscoverySchema>;

/** The title, company, location, country, date window and sort values a cursor is bound to. */
export interface CursorQuery {
  title: string[];
  company: string[];
  location: string[];
  country: string[];
  postedWithin?: number;
  sort: SearchSort;
}

/**
 * A 32-bit FNV-1a over the query, its sort and the offset. This only catches edits and mix-ups (a cursor from another
 * search): the offset is not a secret, and a forged one can only page the same public results.
 */
function checksum(query: CursorQuery, offset: number): string {
  const text = JSON.stringify([
    query.title,
    query.company,
    query.location,
    query.country,
    query.postedWithin ?? null,
    query.sort,
    offset,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const toBase64url = (text: string) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromBase64url(text: string): string | null {
  try {
    const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
    return atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return null;
  }
}

/** The opaque cursor for the page at `offset` of this query. */
export function encodeCursor(query: CursorQuery, offset: number): string {
  return toBase64url(`${offset}.${checksum(query, offset)}`);
}

/**
 * The offset a cursor carries, read without its query and without its checksum. For logs only: it is not a proof the
 * cursor is valid (`decodeCursor` is).
 */
export function cursorOffset(cursor: string): number | null {
  const text = fromBase64url(cursor);
  const match = text === null ? null : /^(\d{1,4})\.[0-9a-f]{8}$/.exec(text);
  return match ? Number(match[1]) : null;
}

/** The offset a cursor stands for, or null when it is malformed, edited, beyond the cap, or for another query. */
export function decodeCursor(cursor: string, query: CursorQuery): number | null {
  const text = fromBase64url(cursor);
  // Only the one spelling encodeCursor writes: base64 can carry the same bytes in more than one string.
  if (text === null || toBase64url(text) !== cursor) return null;
  const match = /^(\d{1,4})\.([0-9a-f]{8})$/.exec(text);
  if (!match) return null;
  const offset = Number(match[1]);
  if (offset >= SEARCH_RESULT_CAP || match[2] !== checksum(query, offset)) return null;
  return offset;
}

/** What a search answer's note calls its order. */
function sortLead(sort: SearchSort): string {
  if (sort === "recent") {
    return "Newest first by the source's posted date, else when Tallo first saw the posting.";
  }
  if (sort === "posted") {
    return "Newest stated posted date first; postings without a source-stated date are not listed.";
  }
  if (sort === "added") return "Most recently added to the catalog first.";
  return "Best matches first.";
}

/** The note on a search answer: what the list is, and whether there is more. */
export function searchNote(input: {
  count: number;
  hasMore: boolean;
  capped: boolean;
  offset: number;
  sort?: SearchSort;
}): string {
  const { count, hasMore, capped, offset } = input;
  const sort = input.sort ?? SEARCH_DEFAULT_SORT;
  if (count === 0) {
    if (offset > 0) {
      return offset >= SEARCH_RESULT_CAP
        ? `There is no page at offset ${offset}: a search lists at most ${SEARCH_RESULT_CAP} results.`
        : "No more open postings match this search. Start again without cursor, or widen the titles.";
    }
    return "No open postings match. Try other title words, or drop a company, a place, a country or a date window.";
  }
  const lead = sortLead(sort);
  if (capped) {
    return `${lead} This page reached the ${SEARCH_RESULT_CAP}-result cap for one search. Refine the titles, company or places to see a different set.`;
  }
  return hasMore
    ? `${lead} Pass next as cursor for the next page.`
    : `${lead} This is the last page.`;
}

/** The chunk of a description from `offset`, and where the next chunk starts (null at the end). */
export function descriptionChunk(
  text: string,
  offset: number,
  limit: number = text.length,
): { text: string; next: number | null } {
  let end = Math.min(text.length, offset + limit);
  // Never split a surrogate pair: move the cut by one unit, away from the pair, keeping the chunk non-empty.
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
    end = end - 1 > offset ? end - 1 : end + 1;
  }
  return { text: text.slice(offset, end), next: end < text.length ? end : null };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
