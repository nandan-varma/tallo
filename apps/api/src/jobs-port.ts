import { gunzip } from "@tallo/catalog";
import type { BlobStore, Db } from "@tallo/db";
import { ftsAllTerms, jdKey, schema, searchJobs, visibleJobs } from "@tallo/db";
import type { JobHit, JobRead, JobsPort } from "@tallo/search-ai";
import { and, eq } from "drizzle-orm";

/** Hits read per title phrase. Phrases are merged round-robin, so every phrase gets a say. */
const PER_QUERY = 20;
const MAX_QUERIES = 8;
const MAX_QUERY_CHARS = 200;

/**
 * The agent's view of the catalog, over D1 and R2. Every read goes through the same visibility
 * predicate as the public search (open, canonical, not hidden, fresh source), so the agent never
 * sees a job the site hides, not even by id. Descriptions are the full gunzipped text.
 */
export function jobsPort(db: Db, blobs: BlobStore): JobsPort {
  return {
    async search(queries, limit) {
      const now = Math.floor(Date.now() / 1000);
      const lists = await Promise.all(
        queries.slice(0, MAX_QUERIES).map(async (raw) => {
          const q = raw.slice(0, MAX_QUERY_CHARS);
          // Exact terms, ANDed: "backend engineer" stays narrow where a bare "engineer" matches most rows.
          const match = ftsAllTerms(q);
          if (!match) return [];
          return (await searchJobs(db, { q, limit: PER_QUERY }, now, match)).jobs;
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
