import { expandPlaces, gunzip } from "@tallo/catalog";
import { SEARCH_RESULT_CAP, type SearchSpec } from "@tallo/contracts";
import type { BlobStore, Db, RankedSpec } from "@tallo/db";
import { countPostedSince, jdKey, payOf, rankedJobs, schema, visibleJobs } from "@tallo/db";
import type { JobHit, JobRead, JobsPort } from "@tallo/search-ai";
import { and, eq, inArray } from "drizzle-orm";

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

/**
 * The agent's view of the catalog, over D1 and R2. Every read goes through the same visibility
 * predicate as the public search (open, canonical, fresh source), so the agent never sees a job the
 * site does not show, not even by id. Descriptions are the full gunzipped text.
 */
export function jobsPort(db: Db, blobs: BlobStore): JobsPort {
  return {
    async search(spec, limit) {
      const now = Math.floor(Date.now() / 1000);
      const rows = await rankedJobs(
        db,
        rankedSpec(spec),
        { limit: Math.min(limit, SEARCH_RESULT_CAP), offset: 0 },
        now,
      );
      return rows.map(toHit);
    },

    async lookup(ids) {
      const numeric = [...new Set(ids.map(Number))]
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 50);
      if (numeric.length === 0) return [];
      const now = Math.floor(Date.now() / 1000);
      const rows = await db
        .select()
        .from(schema.jobs)
        .where(and(inArray(schema.jobs.id, numeric), ...visibleJobs(now)));
      return rows.map((row) => toHit({ ...row, pay: payOf(row.facts) }));
    },

    async read(id): Promise<JobRead | null> {
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0) return null;
      const now = Math.floor(Date.now() / 1000);
      const [row] = await db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.id, n), ...visibleJobs(now)))
        .limit(1);
      if (!row) return null;
      const blob = await blobs.get(jdKey(row.jdHash));
      return {
        ...toHit({ ...row, pay: payOf(row.facts) }),
        applyUrl: row.applyUrl ?? row.url,
        facts: row.facts as Record<string, unknown>,
        description: blob ? new TextDecoder().decode(await gunzip(blob)) : null,
      };
    },
  };
}

/** The fields a hit shows; `pay` is the structured pay line (see `payOf`). */
type HitRow = {
  id: number;
  title: string;
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

function toHit(row: HitRow): JobHit {
  const place = [row.city, row.region, row.countryCode].filter(Boolean).join(", ");
  return {
    id: String(row.id),
    title: row.title,
    company: row.company,
    location: row.locationText ?? (place || null),
    workMode: row.workMode,
    pay: row.pay,
    postedAt: row.postedAt ? new Date(row.postedAt * 1000).toISOString().slice(0, 10) : null,
    department: row.department,
    locations: row.locations ?? 1,
  };
}

/**
 * One page of the database's answer to a search spec, most relevant first: what the person browses beside the
 * chat. Offset paging, capped at `SEARCH_RESULT_CAP` in total. `nextOffset` is null on the last page; there is no
 * count, so a full page at the cap ends the list.
 */
export async function searchPage(
  db: Db,
  input: SearchSpec & { offset: number; limit: number },
  now = Math.floor(Date.now() / 1000),
) {
  const limit = Math.min(input.limit, SEARCH_RESULT_CAP - input.offset);
  if (limit <= 0) return { hits: [], nextOffset: null };
  const rows = await rankedJobs(db, rankedSpec(input), { limit, offset: input.offset }, now);
  const end = input.offset + rows.length;
  return {
    hits: rows.map(toHit),
    nextOffset: rows.length === limit && end < SEARCH_RESULT_CAP ? end : null,
  };
}

/** How many of a saved search's best matches were posted after it was last run, up to `cap`. */
export function newCountSince(db: Db, spec: SearchSpec, seenAt: number, cap: number) {
  return countPostedSince(db, rankedSpec(spec), seenAt, cap);
}
