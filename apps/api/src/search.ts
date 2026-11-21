import { expandPlaces } from "@tallo/catalog";
import {
  type JobHit,
  type Money,
  SEARCH_DEFAULT_SORT,
  SEARCH_RESULT_CAP,
  type SearchPage,
  type SearchSpec,
} from "@tallo/contracts";
import type { Db, RankedSpec } from "@tallo/db";
import { rankedJobs } from "@tallo/db";

const MAX_QUERIES = 8;
const MAX_COMPANIES = 4;
const MAX_QUERY_CHARS = 200;

/**
 * The ranked search a spec asks for. The titles and companies are the words given; the places are expanded here, on
 * the server, from the person's own words (see `expandPlaces`).
 */
export function rankedSpec(spec: SearchSpec): RankedSpec {
  const places = expandPlaces(spec.locations ?? []);
  return {
    titles: spec.queries.slice(0, MAX_QUERIES).map((q) => q.slice(0, MAX_QUERY_CHARS)),
    companies: (spec.companies ?? [])
      .slice(0, MAX_COMPANIES)
      .map((c) => c.slice(0, MAX_QUERY_CHARS)),
    locations: places.locations,
    remote: places.remote,
    countries: (spec.countries ?? []).slice(0, 8).map((code) => code.toUpperCase()),
    postedWithin: spec.postedWithin,
    sort: spec.sort ?? SEARCH_DEFAULT_SORT,
  };
}

/** The fields a hit shows. `pay` is the structured pay line (see `payOf`). */
type HitRow = {
  id: number;
  title: string;
  applyUrl: string | null;
  url: string | null;
  company: string;
  locationText: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  workMode: string | null;
  department: string | null;
  employmentType: string | null;
  postedAt: number | null;
  pay: string | null;
  compensation: Money[];
  sourceLastListedAt: number | null;
  /** Open siblings of this canonical row, this one included (see `summary.variants`). */
  locations: number;
};

/** The place a row shows: the location text the source stated, else its structured city, region and country. */
export function locationOf(row: {
  locationText: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
}): string | null {
  const place = [row.city, row.region, row.countryCode].filter(Boolean).join(", ");
  return row.locationText ?? (place || null);
}

/** `YYYY-MM-DD` from a unix-seconds timestamp, or null. */
export const postedOf = (seconds: number | null): string | null =>
  seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : null;

/** An ISO 8601 UTC timestamp from unix seconds, or null. */
export const seenAt = (seconds: number | null): string | null =>
  seconds === null ? null : new Date(seconds * 1000).toISOString();

function toHit(row: HitRow): JobHit {
  return {
    id: String(row.id),
    title: row.title,
    company: row.company,
    location: locationOf(row),
    workMode: row.workMode as JobHit["workMode"],
    pay: row.pay,
    compensation: row.compensation,
    postedAt: postedOf(row.postedAt),
    department: row.department,
    employmentType: row.employmentType,
    countryCode: row.countryCode,
    applyUrl: row.applyUrl ?? row.url,
    sourceLastListedAt: seenAt(row.sourceLastListedAt),
    locations: row.locations,
  };
}

/**
 * One page of the database's answer to a search spec, in its requested order. Offset paging, capped at
 * `SEARCH_RESULT_CAP` in total. `count` is this page's length; `capped` only says the cap stopped the list.
 */
export async function searchPage(
  db: Db,
  input: SearchSpec & { offset: number; limit: number },
  now = Math.floor(Date.now() / 1000),
): Promise<SearchPage> {
  const spec = rankedSpec(input);
  const limit = Math.min(input.limit, SEARCH_RESULT_CAP - input.offset);
  const asOf = new Date(now * 1000).toISOString();
  const expanded = { locations: spec.locations ?? [], remote: spec.remote ?? false };
  if (limit <= 0) {
    return {
      hits: [],
      nextOffset: null,
      count: 0,
      hasMore: false,
      capped: true,
      expanded,
      asOf,
    };
  }
  const rows = await rankedJobs(db, spec, { limit, offset: input.offset }, now);
  const end = input.offset + rows.length;
  const nextOffset = rows.length === limit && end < SEARCH_RESULT_CAP ? end : null;
  return {
    hits: rows.map(toHit),
    nextOffset,
    count: rows.length,
    hasMore: nextOffset !== null,
    capped: end >= SEARCH_RESULT_CAP,
    expanded,
    asOf,
  };
}
