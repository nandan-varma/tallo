import { z } from "zod";
import { type JobHit, SEARCH_RESULT_CAP } from "./search.ts";

/**
 * The public read API: `GET /v1/search`, `GET /v1/jobs/:id` and `GET /v1/jobs/:id/description`. No auth, GET only,
 * JSON. The web Worker serves these under `tallo.nandan.fyi` through an allowlist; the API implements them. Every
 * limit an LLM reads about is defined here, once, and `llms.txt` is generated from these schemas.
 */

/** The public origin, for the examples in llms.txt. Code never builds links from it. */
export const PUBLIC_ORIGIN = "https://tallo.nandan.fyi";

/**
 * The only paths the public may read, GET only. `:id` is a posting id. The web Worker forwards exactly these to the
 * API and answers 404 for everything else under `/v1`, admin and ingest included.
 */
export const PUBLIC_PATHS = ["/v1/search", "/v1/jobs/:id", "/v1/jobs/:id/description"] as const;

/** A posting id in a path: a positive whole number with no leading zero, at most 16 digits. */
export const POSTING_ID_SOURCE = "[1-9]\\d{0,15}";

/** Longest path plus query the public API accepts, in characters. Longer is answered 414 before any query runs. */
export const PUBLIC_MAX_URL_CHARS = 2048;

export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 25;
/** The first chunk of a description on the job page, and the default chunk of the description route. */
export const DESCRIPTION_CHUNK = 4000;
export const DESCRIPTION_MAX_CHUNK = 8000;

/** Search answers depend only on the query and the catalog's last refresh: cache them for minutes. */
export const SEARCH_CACHE_CONTROL = "public, max-age=60, s-maxage=300";
/** A posting changes rarely: cache its facts and description for an hour at the edge. */
export const JOB_CACHE_CONTROL = "public, max-age=300, s-maxage=3600";

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
    .min(1, "needs 1 to 8 values of 2 to 80 characters each")
    .max(8, "takes at most 8 values")
    .describe(
      "Required. Repeat 1 to 8 times, one job title each, 2 to 80 characters. Use specific titles such as backend engineer; never one generic word.",
    ),
  company: z
    .array(phrase(2, 80))
    .max(4, "takes at most 4 values")
    .default([])
    .describe(
      "Optional. Repeat up to 4 times with company names the person named, 2 to 80 characters each. Matched on the company name and ANDed with the titles.",
    ),
  location: z
    .array(phrase(2, 60))
    .max(8, "takes at most 8 values")
    .default([])
    .describe(
      "Optional. Repeat up to 8 times, 2 to 60 characters each, in the person's own words (NYC, Bay Area, Seattle, remote). The server expands them.",
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
      "Optional. The next value from the previous response, unchanged, with the same title, company and location values. It is opaque; do not build or edit one.",
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
    .max(DESCRIPTION_MAX_CHUNK, `must be at most ${DESCRIPTION_MAX_CHUNK}`)
    .default(DESCRIPTION_CHUNK)
    .describe(
      `Optional. Characters to return, from 1 to ${DESCRIPTION_MAX_CHUNK}. Default ${DESCRIPTION_CHUNK}.`,
    ),
});

/** The error body of every public 4xx: what was wrong, and how to fix the request. */
export interface PublicError {
  error: { code: string; message: string; hint: string };
}

export const publicError = (code: string, message: string, hint: string): PublicError => ({
  error: { code, message, hint },
});

/** `GET /v1/search`. `next` is the cursor for the next page, or null on the last. */
export interface PublicSearchPage {
  results: JobHit[];
  next: string | null;
  note: string;
}

/** The title, company and location values a cursor is bound to. */
export interface CursorQuery {
  title: string[];
  company: string[];
  location: string[];
}

/**
 * A 32-bit FNV-1a over the query and the offset. This only catches edits and mix-ups (a cursor from another search):
 * the offset is not a secret, and a forged one can only page the same public results.
 */
function checksum(query: CursorQuery, offset: number): string {
  const text = JSON.stringify([query.title, query.company, query.location, offset]);
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

/** The offset a cursor stands for, or null when it is malformed, edited, beyond the cap, or for another query. */
export function decodeCursor(cursor: string, query: CursorQuery): number | null {
  const text = fromBase64url(cursor);
  const match = text === null ? null : /^(\d{1,4})\.([0-9a-f]{8})$/.exec(text);
  if (!match) return null;
  const offset = Number(match[1]);
  if (offset >= SEARCH_RESULT_CAP || match[2] !== checksum(query, offset)) return null;
  return offset;
}

/** The note on a search answer: what the list is, and whether there is more. */
export function searchNote(count: number, hasNext: boolean): string {
  if (count === 0) {
    return "No open postings match. Try other title words, or drop a company or a place.";
  }
  const cap = `A search lists at most ${SEARCH_RESULT_CAP} results in total, and there is no count.`;
  return hasNext
    ? `Best matches first. ${cap} Pass next as cursor for the next page.`
    : `Best matches first. This is the last page. ${cap}`;
}

/** The chunk of a description from `offset`, and where the next chunk starts (null at the end). */
export function descriptionChunk(
  text: string,
  offset: number,
  limit: number,
): { text: string; next: number | null } {
  let end = Math.min(text.length, offset + limit);
  // Never split a surrogate pair: move the cut by one unit, away from the pair, keeping the chunk non-empty.
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
    end = end - 1 > offset ? end - 1 : end + 1;
  }
  return { text: text.slice(offset, end), next: end < text.length ? end : null };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
