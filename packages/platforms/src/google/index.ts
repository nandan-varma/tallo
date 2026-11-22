import type { Json, JsonObject, Platform, RawPosting } from "@tallo/contracts";
import { arr, at, num, str } from "@tallo/contracts";
import { describe, locations, SchemaError } from "../kit.ts";

/**
 * Google Careers' public results page server-renders each page of postings into an
 * `AF_initDataCallback` blob (`ds:1`): twenty records with the overview, responsibilities and
 * qualifications already inline, so there is no detail request and no per-job N+1. `?page=N`
 * walks the whole board (measured 3,015 postings, 151 pages). The old `/api/v3/search` endpoint
 * is retired and is not used.
 */
const BASE = "https://www.google.com/about/careers/applications/jobs/results/";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGES = 1000;

/** The `ds:1` payload, found by walking the bracket pair so a `]` inside a description cannot cut it short. */
function ds1(html: string): Json {
  const key = html.indexOf("key: 'ds:1'");
  if (key < 0) throw new SchemaError("Google results page has no ds:1 payload");
  const data = html.indexOf("data:", key);
  const start = data < 0 ? -1 : html.indexOf("[", data);
  if (start < 0) throw new SchemaError("Google ds:1 payload has no data array");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new SchemaError("Google ds:1 payload is not closed");
  try {
    return JSON.parse(html.slice(start, end)) as Json;
  } catch {
    throw new SchemaError("Google ds:1 payload is not JSON");
  }
}

/** Seconds (Google states unix seconds, with nanoseconds beside it) to an ISO instant. */
function isoFromSeconds(value: unknown): string | undefined {
  const seconds = num(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

/** A Google place is `[display, [addresses], city, postal, region, countryCode]`. */
function place(entry: Json) {
  const text = str(at(entry, 0));
  return {
    text,
    hints: {
      city: str(at(entry, 2)),
      region: str(at(entry, 4)),
      countryCode: str(at(entry, 5)),
    },
  };
}

export const google: Platform = {
  id: "google",
  version: 2,
  hosts: ["www.google.com"],

  validate(source) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(source.key))
      throw new Error(`Invalid google key: ${source.key}`);
  },

  async *list(_source, ctx) {
    let total = Number.POSITIVE_INFINITY;
    let pageSize = DEFAULT_PAGE_SIZE;
    let pages = Number.POSITIVE_INFINITY;
    let complete = true;
    const seen = new Set<string>();
    for (let page = 1; page <= pages; page++) {
      if (page > MAX_PAGES) throw new SchemaError(`Google paged past ${MAX_PAGES} pages`);
      const html = (await ctx.http.getText(`${BASE}?page=${page}`)).data;
      const data = ds1(html);
      const rows = arr(at(data, 0));
      const reportedTotal = num(at(data, 2));
      const reportedPageSize = num(at(data, 3)) ?? DEFAULT_PAGE_SIZE;
      if (
        reportedTotal === undefined ||
        !Number.isSafeInteger(reportedTotal) ||
        reportedTotal < 0 ||
        !Number.isSafeInteger(reportedPageSize) ||
        reportedPageSize < 1 ||
        reportedPageSize > 100
      )
        throw new SchemaError("Google ds:1 payload has no valid total or page size");
      if (page === 1) {
        total = reportedTotal;
        pageSize = reportedPageSize;
        pages = total === 0 ? 1 : Math.ceil(total / pageSize);
        if (rows.length === 0 && total > 0)
          throw new SchemaError("Google reported postings but the first page is empty");
      } else if (reportedTotal !== total || reportedPageSize !== pageSize) {
        // A changed board during pagination shifts offsets; never claim the listing is whole.
        complete = false;
      }
      const expected = page < pages ? pageSize : total - (pages - 1) * pageSize;
      if (rows.length !== expected) complete = false;
      for (const row of rows) {
        if (!Array.isArray(row)) throw new SchemaError("Google posting is not an array");
        const id = str(at(row, 0));
        if (!id) throw new SchemaError("Google posting without an id");
        if (!str(at(row, 1))) throw new SchemaError(`Google posting ${id} without a title`);
        if (seen.has(id)) {
          // The same row on two pages means at least one other row moved out of reach.
          complete = false;
          continue;
        }
        seen.add(id);
        yield { id, listing: row as Json } satisfies RawPosting;
      }
    }
    return {
      complete: complete && seen.size === total,
      // The results endpoint is the whole public board; an authoritative zero is a real empty board.
      emptyIsAuthoritative: true,
    };
  },

  map({ id, listing }) {
    const field = (index: number) => at(listing, index);
    const company = str(field(7));
    const targetLevel = num(field(20));
    // Slot 14: the time Google's own `sort_by=date` orders by (slot 12 is an earlier, unexplained time).
    const postedAt = isoFromSeconds(at(field(14), 0));
    // The row's own application link (a Google sign-in that carries the job); anything else is not linked.
    const applyUrl = str(field(2));
    return {
      postingId: id,
      title: str(field(1)) ?? "",
      url: `${BASE}${encodeURIComponent(id)}`,
      ...(applyUrl?.startsWith("https://www.google.com/") ? { applyUrl } : {}),
      description: describe(at(field(10), 1), at(field(3), 1), at(field(4), 1)),
      locations: locations(arr(field(9)).map(place)),
      requisitionId: id,
      ...(postedAt ? { postedAt } : {}),
      compensation: [],
      experience: [],
      extras: {
        ...(company ? { company } : {}),
        ...(targetLevel !== undefined ? { targetLevel } : {}),
        ...(str(field(8)) ? { locale: str(field(8)) } : {}),
      } satisfies JsonObject,
    };
  },
};
