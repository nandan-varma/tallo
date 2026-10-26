import { gunzip } from "@tallo/catalog";
import type { BlobStore, Db } from "@tallo/db";
import { ftsAllTerms, jdKey, schema, searchJobs, visibleJobs } from "@tallo/db";
import type { Candidate, Facts, JobsPort } from "@tallo/search-ai";
import { and, eq, inArray } from "drizzle-orm";

/** Query variants read per ask at most. The engine already caps at 12; this is the port's own bound. */
const MAX_VARIANTS = 12;
/** One read per variant, sorted by sortAt and cut to this many. No cursor paging. */
const PER_VARIANT_LIMIT = 100;
/** Search text is capped where the visible search box caps it. */
const MAX_QUERY_CHARS = 200;

/**
 * The search engine's JobsPort over D1 and R2. Every read goes through the same visibility predicate
 * as the public search (open, canonical, not hidden, fresh source), so the engine never sees a job the
 * site hides, not even by id. Descriptions are the full gunzipped text: never truncated.
 */
export function jobsPort(db: Db, blobs: BlobStore): JobsPort {
  return {
    async recall(queries, limit) {
      const seen = new Map<number, Candidate>();
      const now = Math.floor(Date.now() / 1000);
      for (const raw of queries.slice(0, MAX_VARIANTS)) {
        if (seen.size >= limit) break;
        const q = raw.slice(0, MAX_QUERY_CHARS);
        // A variant with no word characters has no expression to match; skip it.
        const match = ftsAllTerms(q);
        if (!match) continue;
        // One bounded read per variant: FTS matches are sorted by sortAt, so cost grows with matches.
        const { jobs } = await searchJobs(db, { q, limit: PER_VARIANT_LIMIT }, now, match);
        for (const row of jobs) {
          if (!seen.has(row.id) && seen.size < limit) seen.set(row.id, toCandidate(row));
        }
      }
      return [...seen.values()];
    },

    async facts(ids) {
      const out = new Map<string, Facts>();
      const now = Math.floor(Date.now() / 1000);
      const numeric = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      for (let i = 0; i < numeric.length; i += 50) {
        const rows = await db
          .select({
            id: schema.jobs.id,
            department: schema.jobs.department,
            team: schema.jobs.team,
            employmentType: schema.jobs.employmentType,
            countryCode: schema.jobs.countryCode,
            city: schema.jobs.city,
            region: schema.jobs.region,
            expMinYears: schema.jobs.expMinYears,
            expMaxYears: schema.jobs.expMaxYears,
          })
          .from(schema.jobs)
          .where(and(inArray(schema.jobs.id, numeric.slice(i, i + 50)), ...visibleJobs(now)));
        for (const row of rows) {
          out.set(String(row.id), {
            department: row.department,
            team: row.team,
            employmentType: row.employmentType,
            countryCode: row.countryCode,
            city: row.city,
            region: row.region,
            expMinYears: row.expMinYears,
            expMaxYears: row.expMaxYears,
          });
        }
      }
      return out;
    },

    async description(id) {
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0) return null;
      const now = Math.floor(Date.now() / 1000);
      const [row] = await db
        .select({ jdHash: schema.jobs.jdHash })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.id, n), ...visibleJobs(now)))
        .limit(1);
      if (!row) return null;
      const blob = await blobs.get(jdKey(row.jdHash));
      return blob ? new TextDecoder().decode(await gunzip(blob)) : null;
    },
  };
}

type Row = Awaited<ReturnType<typeof searchJobs>>["jobs"][number];

function toCandidate(row: Row): Candidate {
  const place = [row.city, row.region, row.countryCode].filter(Boolean).join(", ");
  const locations = row.locationText ? [row.locationText] : place ? [place] : [];
  return {
    id: String(row.id),
    title: row.title,
    company: row.company,
    locations,
    workMode: row.workMode,
    pay: payText(row),
    postedAt: row.postedAt ? new Date(row.postedAt * 1000).toISOString().slice(0, 10) : null,
  };
}

function payText(row: Row): string | null {
  const low = row.salaryMinAnnual ?? row.salaryMaxAnnual;
  const high = row.salaryMaxAnnual ?? row.salaryMinAnnual;
  if (low === null || high === null) return null;
  return `${row.salaryCurrency ?? ""} ${low}-${high} per year`.trim();
}
