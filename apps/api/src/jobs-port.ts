import { gunzip } from "@tallo/catalog";
import type { BlobStore, Db } from "@tallo/db";
import { ftsQuery, getJob, jdKey, schema, searchJobs } from "@tallo/db";
import type { Candidate, Facts, JobsPort } from "@tallo/search-ai";
import { inArray } from "drizzle-orm";

/** Per recall query: pages read at most, so one broad title cannot scan the whole catalog. */
const MAX_PAGES_PER_QUERY = 3;
const PAGE_SIZE = 100;
/** Search text is capped where the visible search box caps it. */
const MAX_QUERY_CHARS = 200;

/**
 * The search engine's JobsPort over D1 and R2. Reads go through the same visibility predicate as
 * the public search (open, not hidden, fresh source), so the engine never sees a job the site hides.
 * Descriptions are the full gunzipped text: never truncated.
 */
export function jobsPort(db: Db, blobs: BlobStore): JobsPort {
  return {
    async recall(queries, limit) {
      const seen = new Map<number, Candidate>();
      const now = Math.floor(Date.now() / 1000);
      for (const raw of queries) {
        const q = raw.slice(0, MAX_QUERY_CHARS);
        // A query with no word characters would match every visible job; skip it instead.
        if (!ftsQuery(q)) continue;
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES_PER_QUERY && seen.size < limit; page++) {
          const result = await searchJobs(db, { q, limit: PAGE_SIZE, cursor }, now);
          for (const row of result.jobs) {
            if (!seen.has(row.id) && seen.size < limit) seen.set(row.id, toCandidate(row));
          }
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
      }
      return [...seen.values()];
    },

    async facts(ids) {
      const out = new Map<string, Facts>();
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
          .where(inArray(schema.jobs.id, numeric.slice(i, i + 50)));
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
      const job = await getJob(db, Number(id));
      if (!job) return null;
      const blob = await blobs.get(jdKey(job.jdHash));
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
