import { expandPlaces } from "@tallo/catalog";
import { type JobHit, SEARCH_RESULT_CAP, type SearchPage, type SearchSpec } from "@tallo/contracts";
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
  postedAt: number | null;
  pay: string | null;
  /** From a ranked search: postings of this company and title among the candidates. */
  locations?: number;
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

function toHit(row: HitRow): JobHit {
  return {
    id: String(row.id),
    title: row.title,
    company: row.company,
    location: locationOf(row),
    workMode: row.workMode,
    pay: row.pay,
    postedAt: postedOf(row.postedAt),
    department: row.department,
    applyUrl: row.applyUrl ?? row.url,
    locations: row.locations ?? 1,
  };
}

/**
 * One page of the database's answer to a search spec, most relevant first. Offset paging, capped at
 * `SEARCH_RESULT_CAP` in total. `nextOffset` is null on the last page; there is no count, so a full page at the cap
 * ends the list.
 */
export async function searchPage(
  db: Db,
  input: SearchSpec & { offset: number; limit: number },
  now = Math.floor(Date.now() / 1000),
): Promise<SearchPage> {
  const limit = Math.min(input.limit, SEARCH_RESULT_CAP - input.offset);
  if (limit <= 0) return { hits: [], nextOffset: null };
  const rows = await rankedJobs(db, rankedSpec(input), { limit, offset: input.offset }, now);
  const end = input.offset + rows.length;
  return {
    hits: rows.map(toHit),
    nextOffset: rows.length === limit && end < SEARCH_RESULT_CAP ? end : null,
  };
}
