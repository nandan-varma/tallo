import type { Facets } from "@tallo/contracts";
import { STALE_FLAG_DAYS, STALE_HIDE_DAYS } from "@tallo/contracts";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import { facetCounts, jobs, runs, sources } from "./schema.ts";

/** Most values kept per facet. Bounds the snapshot size and the dropdown length. */
export const FACET_LIMIT = 100;

export const searchSchema = z.object({
  q: z.string().trim().max(200).optional(),
  company: z.string().max(100).optional(),
  country: z.string().length(2).toUpperCase().optional(),
  workMode: z.enum(["remote", "hybrid", "onsite"]).optional(),
  department: z.string().max(200).optional(),
  employmentType: z.string().max(100).optional(),
  /** Pay band overlaps at least this annual amount. */
  salaryMin: z.coerce.number().nonnegative().optional(),
  /** Required experience is at most this many years (unknown experience matches). */
  maxExperience: z.coerce.number().nonnegative().optional(),
  postedWithinDays: z.coerce.number().int().positive().max(365).optional(),
  /** Include jobs the heuristics hide (non-US / non-tech). */
  all: z.coerce.boolean().optional(),
  /** Include jobs from sources that stopped listing for STALE_HIDE_DAYS. */
  includeStale: z.coerce.boolean().optional(),
  cursor: z
    .string()
    .regex(/^\d+\.\d+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type Search = z.infer<typeof searchSchema>;

/** Safe FTS5 expression: every term must match, the last as a prefix. */
export function ftsQuery(q: string): string | undefined {
  const terms = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return terms?.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
}

const summary = {
  id: jobs.id,
  title: jobs.title,
  applyUrl: jobs.applyUrl,
  url: jobs.url,
  company: jobs.company,
  companySlug: jobs.companySlug,
  locationText: jobs.locationText,
  city: jobs.city,
  region: jobs.region,
  countryCode: jobs.countryCode,
  workMode: jobs.workMode,
  department: jobs.department,
  employmentType: jobs.employmentType,
  postedAt: jobs.postedAt,
  salaryMinAnnual: jobs.salaryMinAnnual,
  salaryMaxAnnual: jobs.salaryMaxAnnual,
  salaryCurrency: jobs.salaryCurrency,
  expMinYears: jobs.expMinYears,
  excerpt: jobs.excerpt,
  sortAt: jobs.sortAt,
  /**
   * Open listings of this posting, this row included (see `dup_of`). The outer id is spelled out:
   * drizzle renders `${jobs.id}` unqualified, which the subquery's own `id` would shadow.
   */
  variants: sql<number>`(SELECT count(*) FROM jobs AS dup WHERE dup.dup_of = "jobs"."id" AND dup.closed_at IS NULL) + 1`,
};

/**
 * What a default search shows: open canonical jobs (one per duplicate group, see `dup_of`), not
 * heuristically hidden, from sources that listed recently. Facet counts use the same predicate so
 * every count matches its filter's results.
 */
export function visibleJobs(now: number, { all = false, includeStale = false } = {}): SQL[] {
  return [
    sql`${jobs.closedAt} IS NULL`,
    sql`${jobs.dupOf} IS NULL`,
    ...(all ? [] : [sql`${jobs.hidden} = 0`]),
    ...(includeStale
      ? []
      : [
          sql`NOT EXISTS (SELECT 1 FROM sources WHERE sources.id = ${jobs.sourceId} AND coalesce(sources.last_listed_at, 0) < ${now - STALE_HIDE_DAYS * 86400})`,
        ]),
  ];
}

export async function searchJobs(db: Db, input: Search, now = Math.floor(Date.now() / 1000)) {
  const match = input.q ? ftsQuery(input.q) : undefined;
  const where: (SQL | undefined)[] = [
    ...visibleJobs(now, input),
    match
      ? sql`${jobs.id} IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ${match})`
      : undefined,
    input.company ? eq(jobs.companySlug, input.company) : undefined,
    input.country ? eq(jobs.countryCode, input.country) : undefined,
    input.workMode ? eq(jobs.workMode, input.workMode) : undefined,
    input.department ? eq(jobs.department, input.department) : undefined,
    input.employmentType ? eq(jobs.employmentType, input.employmentType) : undefined,
    input.salaryMin === undefined
      ? undefined
      : sql`coalesce(${jobs.salaryMaxAnnual}, ${jobs.salaryMinAnnual}) >= ${input.salaryMin}`,
    input.maxExperience === undefined
      ? undefined
      : sql`(${jobs.expMinYears} IS NULL OR ${jobs.expMinYears} <= ${input.maxExperience})`,
    input.postedWithinDays
      ? sql`${jobs.sortAt} >= ${now - input.postedWithinDays * 86400}`
      : undefined,
  ];
  if (input.cursor) {
    const [at, id] = input.cursor.split(".").map(Number);
    where.push(sql`(${jobs.sortAt}, ${jobs.id}) < (${at}, ${id})`);
  }
  const rows = await db
    .select(summary)
    .from(jobs)
    .where(and(...where))
    .orderBy(desc(jobs.sortAt), desc(jobs.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    jobs: page,
    nextCursor: rows.length > input.limit && last ? `${last.sortAt}.${last.id}` : null,
  };
}

/**
 * Reads the precomputed facet snapshot: one small table scan, no `jobs` access. The table is
 * rebuilt by `rebuildFacets` (hourly cron), so counts can lag by up to an hour.
 */
export async function listFacets(db: Db): Promise<Facets> {
  const rows = await db
    .select()
    .from(facetCounts)
    .orderBy(desc(facetCounts.count), facetCounts.value);
  const facets: Facets = {
    computedAt: null,
    workMode: [],
    department: [],
    employmentType: [],
    country: [],
  };
  for (const row of rows) {
    facets.computedAt = Math.max(facets.computedAt ?? 0, row.computedAt);
    if (
      row.facet === "workMode" ||
      row.facet === "department" ||
      row.facet === "employmentType" ||
      row.facet === "country"
    ) {
      facets[row.facet].push({ value: row.value, count: row.count });
    }
  }
  return facets;
}

export async function getJob(db: Db, id: number) {
  return (await db.select().from(jobs).where(eq(jobs.id, id)).limit(1))[0];
}

/**
 * Every open listing of the job's posting, canonical first: the job page shows each location
 * and apply link. Includes the job itself.
 */
export async function listVariants(db: Db, job: { id: number; dupOf: number | null }) {
  const canonical = job.dupOf ?? job.id;
  return db
    .select({
      id: jobs.id,
      url: jobs.url,
      applyUrl: jobs.applyUrl,
      locationText: jobs.locationText,
      city: jobs.city,
      region: jobs.region,
      countryCode: jobs.countryCode,
      workMode: jobs.workMode,
      postedAt: jobs.postedAt,
    })
    .from(jobs)
    .where(or(eq(jobs.id, canonical), and(eq(jobs.dupOf, canonical), isNull(jobs.closedAt))))
    .orderBy(jobs.id);
}

export type Freshness = "fresh" | "stale" | "hidden";

export const freshness = (
  lastListedAt: number | null,
  now = Math.floor(Date.now() / 1000),
): Freshness => {
  const days = lastListedAt === null ? Number.POSITIVE_INFINITY : (now - lastListedAt) / 86400;
  return days >= STALE_HIDE_DAYS ? "hidden" : days >= STALE_FLAG_DAYS ? "stale" : "fresh";
};

export async function listSources(db: Db, now = Math.floor(Date.now() / 1000)) {
  const rows = await db.select().from(sources).orderBy(sources.id);
  return rows.map((source) => ({ ...source, freshness: freshness(source.lastListedAt, now) }));
}

/** Slim per-source view for the status page: no `params`, no `consecutiveFailures`. */
export async function listSourceStatus(db: Db, now = Math.floor(Date.now() / 1000)) {
  const rows = await db
    .select({
      id: sources.id,
      platform: sources.platform,
      company: sources.company,
      key: sources.key,
      lastRunAt: sources.lastRunAt,
      lastCompleteRunAt: sources.lastCompleteRunAt,
      lastListedAt: sources.lastListedAt,
      lastStatus: sources.lastStatus,
    })
    .from(sources)
    .orderBy(sources.id);
  return rows.map((source) => ({ ...source, freshness: freshness(source.lastListedAt, now) }));
}

export const runsSearchSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Only runs that ended partial or reported issues: the ones an operator needs to see. */
  attention: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export type RunsSearch = z.infer<typeof runsSearchSchema>;

/** Operational run history, newest first. Raw pack keys stay internal. */
export async function listRuns(db: Db, input: RunsSearch) {
  const where = input.attention
    ? or(eq(runs.status, "partial"), sql`json_array_length(${runs.issues}) > 0`)
    : undefined;
  return db
    .select({
      id: runs.id,
      sourceId: runs.sourceId,
      runnerId: runs.runnerId,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      status: runs.status,
      seen: runs.seen,
      added: runs.added,
      changed: runs.changed,
      closed: runs.closed,
      issues: runs.issues,
    })
    .from(runs)
    .where(where)
    .orderBy(desc(runs.startedAt))
    .limit(input.limit);
}
