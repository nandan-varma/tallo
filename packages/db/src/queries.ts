import { type Money, payText, STALE_FLAG_DAYS, STALE_HIDE_DAYS } from "@tallo/contracts";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import { jobs, runs, sources } from "./schema.ts";

/** Catalog search: free text, paging, and the stale-source switch. The database filters nothing else. */
export const searchSchema = z.object({
  q: z.string().trim().max(200).optional(),
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
function ftsQuery(q: string): string | undefined {
  const terms = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return terms?.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
}

/**
 * Safe FTS5 expression for recall: every term must match as a whole token (AND, no prefix), so a
 * title variant like "backend engineer" stays narrow. Quoting drops every FTS operator character.
 */
export function ftsAllTerms(q: string): string | undefined {
  const terms = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return terms?.map((t) => `"${t}"`).join(" ");
}

/**
 * A MATCH clause that requires the job's location text to mention any of `locations` (OR), where each entry
 * must contain all of its words (AND): ["Seattle", "WA"] is Seattle or WA, ["San Francisco"] needs both words.
 * Words are quoted, so no FTS operator can come through. Undefined when no entry has a word.
 */
export function ftsLocations(locations: string[]): string | undefined {
  const alternatives = locations.flatMap((location) => {
    const words = location.toLowerCase().match(/[\p{L}\p{N}]+/gu);
    if (!words) return [];
    const quoted = words.map((w) => `"${w}"`);
    return [quoted.length > 1 ? `(${quoted.join(" ")})` : (quoted[0] as string)];
  });
  return alternatives.length > 0 ? `location_text : (${alternatives.join(" OR ")})` : undefined;
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
  /** Read for `pay` only; never returned as is. */
  facts: jobs.facts,
  excerpt: jobs.excerpt,
  sortAt: jobs.sortAt,
  /**
   * Open listings of this posting, this row included (see `dup_of`). The outer id is spelled out:
   * drizzle renders `${jobs.id}` unqualified, which the subquery's own `id` would shadow.
   */
  variants: sql<number>`(SELECT count(*) FROM jobs AS dup WHERE dup.dup_of = "jobs"."id" AND dup.closed_at IS NULL) + 1`,
};

/** The pay line of a row, from its stored facts (see `payText`). */
export const payOf = (facts: Record<string, unknown>) =>
  payText(facts.compensation as Money[] | undefined);

/**
 * What a default search shows: open canonical jobs (one per duplicate group, see `dup_of`), from
 * sources that listed recently. The same predicate is used so every count matches its results.
 */
export function visibleJobs(now: number, { includeStale = false } = {}): SQL[] {
  return [
    sql`${jobs.closedAt} IS NULL`,
    sql`${jobs.dupOf} IS NULL`,
    ...(includeStale
      ? []
      : [
          sql`NOT EXISTS (SELECT 1 FROM sources WHERE sources.id = ${jobs.sourceId} AND coalesce(sources.last_listed_at, 0) < ${now - STALE_HIDE_DAYS * 86400})`,
        ]),
  ];
}

/**
 * `fts` is a ready MATCH expression (see `ftsAllTerms`); when omitted, `input.q` becomes `ftsQuery`.
 * Recall passes its own expression so it can use exact terms while the public search keeps prefixes.
 */
export async function searchJobs(
  db: Db,
  input: Search,
  now = Math.floor(Date.now() / 1000),
  fts?: string,
) {
  const match = fts ?? (input.q ? ftsQuery(input.q) : undefined);
  const where: (SQL | undefined)[] = [
    ...visibleJobs(now, input),
    match
      ? sql`${jobs.id} IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ${match})`
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
  const page = rows.slice(0, input.limit).map(({ facts, ...row }) => ({
    ...row,
    pay: payOf(facts),
  }));
  const last = page.at(-1);
  return {
    jobs: page,
    nextCursor: rows.length > input.limit && last ? `${last.sortAt}.${last.id}` : null,
  };
}

export async function getJob(db: Db, id: number) {
  const row = (await db.select().from(jobs).where(eq(jobs.id, id)).limit(1))[0];
  return row ? { ...row, pay: payOf(row.facts) } : undefined;
}

/**
 * Every open listing of the job's posting, lowest id first: the job page shows each location and
 * apply link. Closed listings are never listed, the canonical included. Includes the job itself
 * when it is open.
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
    .where(and(isNull(jobs.closedAt), or(eq(jobs.id, canonical), eq(jobs.dupOf, canonical))))
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
type RunsSearch = z.infer<typeof runsSearchSchema>;

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
