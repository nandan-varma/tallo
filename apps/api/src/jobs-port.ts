import { gunzip } from "@tallo/catalog";
import type { SearchSpec } from "@tallo/contracts";
import type { BlobStore, Db } from "@tallo/db";
import { ftsAllTerms, ftsLocations, jdKey, schema, searchJobs, visibleJobs } from "@tallo/db";
import type { JobHit, JobRead, JobsPort } from "@tallo/search-ai";
import { and, eq, inArray } from "drizzle-orm";

/** Hits read per title phrase. Phrases are merged round-robin, so every phrase gets a say. */
const PER_QUERY = 20;
const MAX_QUERIES = 8;
const MAX_QUERY_CHARS = 200;

/**
 * A named place is part of the match itself: it narrows the index lookup, instead of filtering only the
 * newest few hits afterwards.
 */
const withPlace = (titles: string, place: string | undefined) =>
  place ? `(${titles}) AND ${place}` : titles;

/**
 * The agent's view of the catalog, over D1 and R2. Every read goes through the same visibility
 * predicate as the public search (open, canonical, not hidden, fresh source), so the agent never
 * sees a job the site hides, not even by id. Descriptions are the full gunzipped text.
 */
export function jobsPort(db: Db, blobs: BlobStore): JobsPort {
  return {
    async search(queries, limit, options) {
      const now = Math.floor(Date.now() / 1000);
      const place = ftsLocations(options?.locations ?? []);
      const lists = await Promise.all(
        queries.slice(0, MAX_QUERIES).map(async (raw) => {
          const q = raw.slice(0, MAX_QUERY_CHARS);
          // Exact terms, ANDed: "backend engineer" stays narrow where a bare "engineer" matches most rows.
          const titles = ftsAllTerms(q);
          if (!titles) return [];
          return (await searchJobs(db, { q, limit: PER_QUERY }, now, withPlace(titles, place)))
            .jobs;
        }),
      );
      const seen = new Map<number, JobHit>();
      for (let i = 0; i < PER_QUERY && seen.size < limit; i++) {
        for (const list of lists) {
          const row = list[i];
          if (row && !seen.has(row.id) && seen.size < limit) seen.set(row.id, toHit(row));
        }
      }
      return [...seen.values()];
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
      return rows.map(toHit);
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
        ...toHit(row),
        applyUrl: row.applyUrl ?? row.url,
        facts: row.facts as Record<string, unknown>,
        description: blob ? new TextDecoder().decode(await gunzip(blob)) : null,
      };
    },
  };
}

type Row = Awaited<ReturnType<typeof searchJobs>>["jobs"][number];

function toHit(row: Pick<Row, keyof Row & keyof typeof schema.jobs.$inferSelect>): JobHit {
  const place = [row.city, row.region, row.countryCode].filter(Boolean).join(", ");
  return {
    id: String(row.id),
    title: row.title,
    company: row.company,
    location: row.locationText ?? (place || null),
    workMode: row.workMode,
    pay: payText(row),
    postedAt: row.postedAt ? new Date(row.postedAt * 1000).toISOString().slice(0, 10) : null,
    department: row.department,
  };
}

function payText(row: Pick<Row, "salaryMinAnnual" | "salaryMaxAnnual" | "salaryCurrency">) {
  const low = row.salaryMinAnnual ?? row.salaryMaxAnnual;
  const high = row.salaryMaxAnnual ?? row.salaryMinAnnual;
  if (low === null || high === null) return null;
  return `${row.salaryCurrency ?? ""} ${low}-${high} per year`.trim();
}

/**
 * One page of the database's answer to a search spec, newest first (keyset cursor). This is the list the
 * person browses: the assistant only chose the spec. One OR across the title phrases, ANDed with the places,
 * so a page is one indexed lookup however many phrases there are.
 */
export async function searchPage(db: Db, input: SearchSpec & { cursor?: string; limit: number }) {
  const { jobs, nextCursor } = await newestFor(db, input, {
    limit: input.limit,
    cursor: input.cursor,
  });
  return { hits: jobs.map(toHit), nextCursor };
}

/** The FTS MATCH for a spec: any title phrase (OR), ANDed with the places. Undefined when no phrase has a word. */
function specMatch(spec: SearchSpec): string | undefined {
  const phrases = spec.queries
    .slice(0, MAX_QUERIES)
    .map((q) => ftsAllTerms(q.slice(0, MAX_QUERY_CHARS)))
    .filter((expression): expression is string => Boolean(expression))
    .map((expression) => `(${expression})`);
  if (phrases.length === 0) return undefined;
  return withPlace(phrases.join(" OR "), ftsLocations(spec.locations ?? []));
}

/** The raw newest-first rows a spec matches, as the results list reads them (with `sortAt`). */
export async function newestFor(
  db: Db,
  spec: SearchSpec,
  page: { limit: number; cursor?: string },
  now = Math.floor(Date.now() / 1000),
) {
  const match = specMatch(spec);
  if (!match) return { jobs: [] as Row[], nextCursor: null };
  return searchJobs(db, page, now, match);
}
