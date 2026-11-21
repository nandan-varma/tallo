import {
  type Money,
  payText,
  SEARCH_DEFAULT_SORT,
  type SearchSort,
  STALE_FLAG_DAYS,
  STALE_HIDE_DAYS,
} from "@tallo/contracts";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import type { JobRow } from "./schema.ts";
import { companies, jobs, runs, sources, titleTokens } from "./schema.ts";

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
 * `column : (A OR B)` for one FTS column. Each entry must contain all of its words (AND), as whole tokens with no
 * prefix: ["Seattle", "San Francisco"] is Seattle or (San AND Francisco). Words are quoted and only letters and
 * digits survive, so no FTS operator can come through. Undefined when no entry has a word.
 */
export function ftsScope(
  column: "title" | "company" | "location_text",
  entries: string[],
): string | undefined {
  const alternatives = entries.flatMap((entry) => {
    const words = entry.toLowerCase().match(/[\p{L}\p{N}]+/gu);
    if (!words) return [];
    const quoted = words.map((w) => `"${w}"`);
    return [quoted.length > 1 ? `(${quoted.join(" ")})` : (quoted[0] as string)];
  });
  return alternatives.length > 0 ? `${column} : (${alternatives.join(" OR ")})` : undefined;
}

/** Candidates the ranked search reads before it collapses, joins and pages: the best this many by relevance. */
export const RANK_CANDIDATES = 2000;

/**
 * What a ranked search asks for. Each title phrase is ORed (a phrase needs all its words, as whole tokens);
 * companies are ANDed with the titles. `locations` are ANDed with the titles, which narrows the index lookup,
 * except that `remote` is ORed with them: remote work is a work-mode match on the row, not a text match.
 */
export interface RankedSpec {
  titles: string[];
  companies?: string[];
  locations?: string[];
  remote?: boolean;
  /** ISO 3166-1 alpha-2 codes to keep (case-insensitive); a row with no country code never matches. */
  countries?: string[];
  /** Keep rows whose `sort_at` (posted date, else first seen) is this many days old or newer. */
  postedWithin?: number;
  /** Result order. Date sorts bypass the relevance candidate window and do not collapse duplicate rows. */
  sort?: SearchSort;
}

/**
 * bm25 column weights for `jobs_fts` (title, company, location_text): a title word is worth five company words and
 * ten location words. Swept on the evaluation set (`packages/db/eval`): the settings tried were within
 * noise of each other, so these stay.
 */
export const BM25_WEIGHTS = [10, 2, 1] as const;

/** The MATCH for a spec's titles and companies (and locations, unless remote is ORed in). Undefined when none has a word. */
function rankedMatch(spec: RankedSpec): string | undefined {
  const parts = [
    ftsScope("title", spec.titles),
    ftsScope("company", spec.companies ?? []),
    spec.remote ? undefined : ftsScope("location_text", spec.locations ?? []),
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

/** With `remote`: work mode is remote, or the location text matches the places. Undefined when remote was not asked. */
function remoteOrPlaces(spec: RankedSpec): SQL | undefined {
  if (!spec.remote) return undefined;
  const places = ftsScope("location_text", spec.locations ?? []);
  if (!places) return eq(jobs.workMode, "remote");
  return or(
    eq(jobs.workMode, "remote"),
    sql`${jobs.id} IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ${places})`,
  );
}

/**
 * The structured field filters a spec asks for, applied by every sort: a country-code match (never inferred) and a
 * date window on `sort_at` (the source's posted date, else first seen). Both run before the relevance cut.
 */
function fieldFilters(spec: RankedSpec, now: number): SQL[] {
  const filters: SQL[] = [];
  if (spec.postedWithin !== undefined) {
    filters.push(sql`${jobs.sortAt} >= ${now - spec.postedWithin * 86400}`);
  }
  if (spec.countries && spec.countries.length > 0) {
    const codes = spec.countries.map((code) => code.toUpperCase());
    filters.push(
      sql`upper(${jobs.countryCode}) IN (${sql.join(
        codes.map((code) => sql`${code}`),
        sql`, `,
      )})`,
    );
  }
  return filters;
}

/**
 * The filter a search applies before it cuts to the best candidates: what the site shows (`visibleJobs`), the
 * remote or place ask, and the structured field filters. It must run inside the cut: a filter applied after
 * `RANK_CANDIDATES` drops the postings that lost the cut. Closed postings would take the window from open ones,
 * and onsite postings from remote ones.
 */
function candidateFilter(spec: RankedSpec, now: number): SQL[] {
  const remote = remoteOrPlaces(spec);
  return [...visibleJobs(now), ...fieldFilters(spec, now), ...(remote ? [remote] : [])];
}

/**
 * The best `RANK_CANDIDATES` rows for a MATCH that pass `filter`, by bm25 (BM25_WEIGHTS), ties by rowid. A bounded
 * subquery: however broad the terms, no more rows than this are read from the index.
 */
function candidatesFor(match: string, filter: SQL[]) {
  const score = sql`bm25(jobs_fts, ${sql.raw(BM25_WEIGHTS.join(", "))})`;
  return sql`(SELECT jobs_fts.rowid AS id, ${score} AS score FROM jobs_fts JOIN jobs ON jobs.id = jobs_fts.rowid WHERE jobs_fts MATCH ${match} AND ${and(...filter)} ORDER BY ${score}, jobs_fts.rowid LIMIT ${RANK_CANDIDATES})`;
}

/**
 * What one result row stands for: a company, a title and, when the source gave one, a requisition of that source. Two
 * postings with the same title but different requisition ids stay apart; the same requisition in several cities is
 * one row. The requisition only ever splits a company and title group, never joins two (so a source that repeats one
 * placeholder id on every posting cannot merge them). Only structured fields are read; no text is compared.
 */
export const groupKey = sql`${jobs.companySlug} || char(31) || lower(${jobs.title}) || char(31) || coalesce(${jobs.sourceId} || char(31) || ${jobs.requisitionId}, '')`;

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

/**
 * Open rows of this row's `dup_of` group, this row included. A date sort lists every location, so a sibling row
 * must count its whole group rather than only the rows whose `dup_of` points at the sibling.
 */
const groupLocations = sql<number>`(SELECT count(*) FROM jobs AS dup WHERE (dup.id = coalesce("jobs"."dup_of", "jobs"."id") OR dup.dup_of = coalesce("jobs"."dup_of", "jobs"."id")) AND dup.closed_at IS NULL)`;

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
    ...(includeStale ? [] : [sourceListed(now)]),
  ];
}

/** The source of the row has listed recently enough that search shows its postings (see `STALE_HIDE_DAYS`). */
function sourceListed(now: number): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM sources WHERE sources.id = ${jobs.sourceId} AND coalesce(sources.last_listed_at, 0) < ${now - STALE_HIDE_DAYS * 86400})`;
}

/**
 * What a date-sorted search shows: every open listing from a source that listed recently. Unlike `visibleJobs`,
 * duplicate locations stay separate rows: `recent` and `posted` list each open location as its own hit.
 */
function listedJobs(now: number): SQL[] {
  return [sql`${jobs.closedAt} IS NULL`, sourceListed(now)];
}

/**
 * Newest first, keyset-paged: `GET /v1/jobs` (which requires `q`). Free text is prefix-matched on its last word.
 * Text with no searchable word matches nothing, the same as `rankedJobs`.
 */
export async function searchJobs(db: Db, input: Search, now = Math.floor(Date.now() / 1000)) {
  const match = input.q ? ftsQuery(input.q) : undefined;
  if (input.q && !match) return { jobs: [], nextCursor: null };
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

/**
 * The results of a date-sorted search: `recent` and `posted` by `sort_at` (then id), `added` by id. The same FTS
 * match, source freshness and place/remote filters as the ranked search, but no bm25 candidate cut and no grouping:
 * each open location is its own row, with `locations` still counting its open `dup_of` siblings.
 */
async function dateJobs(
  db: Db,
  spec: RankedSpec,
  sort: Exclude<SearchSort, "relevance">,
  page: { limit: number; offset: number },
  now: number,
) {
  const match = rankedMatch(spec);
  if (!match) return [];
  const filter = listedJobs(now);
  filter.push(...fieldFilters(spec, now));
  if (sort === "posted") filter.push(sql`${jobs.postedAt} IS NOT NULL`);
  const remote = remoteOrPlaces(spec);
  if (remote) filter.push(remote);
  const rows = await db
    .select({
      ...summary,
      locations: groupLocations,
      sourceLastListedAt: sources.lastListedAt,
    })
    .from(jobs)
    .innerJoin(sources, eq(sources.id, jobs.sourceId))
    .where(
      and(sql`${jobs.id} IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ${match})`, ...filter),
    )
    .orderBy(...(sort === "added" ? [desc(jobs.id)] : [desc(jobs.sortAt), desc(jobs.id)]))
    .limit(page.limit)
    .offset(page.offset);
  return rows.map(({ facts, variants: _variants, ...row }) => ({
    ...row,
    pay: payOf(facts),
    compensation: (facts.compensation as Money[] | undefined) ?? [],
  }));
}

/**
 * The results for a spec: most relevant first by default. `relevance` returns one row per `groupKey` (a requisition,
 * else a company and title): the best-ranked location, with `locations` = how many of the candidates share that key.
 * `recent`, `posted` and `added` order by date or insertion and list every open location. Only what the site shows.
 * Paged by offset (rank has no keyset); the caller caps the total. No searchable word means no rows.
 */
export async function rankedJobs(
  db: Db,
  spec: RankedSpec,
  page: { limit: number; offset: number },
  now = Math.floor(Date.now() / 1000),
) {
  const sort = spec.sort ?? SEARCH_DEFAULT_SORT;
  if (sort !== "relevance") return dateJobs(db, spec, sort, page, now);
  const match = rankedMatch(spec);
  if (!match) return [];
  const rows = await db
    .select({
      ...summary,
      score: sql<number>`min(cand.score)`,
      // The open siblings of this canonical row, this one included: the same `dup_of` group `listVariants` lists.
      locations: summary.variants,
      sourceLastListedAt: sources.lastListedAt,
    })
    .from(sql`${candidatesFor(match, candidateFilter(spec, now))} AS cand`)
    .innerJoin(jobs, sql`${jobs.id} = cand.id`)
    .innerJoin(sources, eq(sources.id, jobs.sourceId))
    .groupBy(groupKey)
    .orderBy(sql`score`, jobs.id)
    .limit(page.limit)
    .offset(page.offset);
  return rows.map(({ facts, variants: _variants, ...row }) => ({
    ...row,
    pay: payOf(facts),
    compensation: (facts.compensation as Money[] | undefined) ?? [],
  }));
}

export async function getJob(db: Db, id: number) {
  const row = (await db.select().from(jobs).where(eq(jobs.id, id)).limit(1))[0];
  return row ? { ...row, pay: payOf(row.facts) } : undefined;
}

/**
 * The job a public read may show: open, and from a source search still shows. A closed posting or a hidden source
 * answers undefined, as it does in search. A duplicate listing that is still open answers, as its own location.
 */
export async function openJob(db: Db, id: number, now = Math.floor(Date.now() / 1000)) {
  const state = await jobState(db, id, now);
  return state.kind === "ok" ? state.job : undefined;
}

/**
 * Why a posting is or is not readable. The three negative states are facts about the row, never guesses:
 * `closed` has a closed_at, `source_hidden` exists from a board that stopped listing, `unknown` has no row.
 */
export type JobState =
  | { kind: "ok"; job: JobRow & { pay: string | null; sourceLastListedAt: number | null } }
  | { kind: "closed" }
  | { kind: "source_hidden" }
  | { kind: "unknown" };

/** The state of one posting for a public read: open, closed, from a hidden source, or absent. */
export async function jobState(
  db: Db,
  id: number,
  now = Math.floor(Date.now() / 1000),
): Promise<JobState> {
  const row = (
    await db
      .select({ job: jobs, lastListedAt: sources.lastListedAt })
      .from(jobs)
      .leftJoin(sources, eq(sources.id, jobs.sourceId))
      .where(eq(jobs.id, id))
      .limit(1)
  )[0];
  if (!row) return { kind: "unknown" };
  if (row.job.closedAt !== null) return { kind: "closed" };
  if (row.lastListedAt === null || row.lastListedAt < now - STALE_HIDE_DAYS * 86400)
    return { kind: "source_hidden" };
  return {
    kind: "ok",
    job: { ...row.job, pay: payOf(row.job.facts), sourceLastListedAt: row.lastListedAt },
  };
}

/** Company names and slugs for `/v1/companies`: a small aggregate table, not a scan of `jobs`. */
export async function listCompanies(
  db: Db,
  { prefix, limit }: { prefix?: string; limit: number },
): Promise<{ companies: { name: string; slug: string }[]; truncated: boolean }> {
  const from = (prefix ?? "").trim().toLowerCase();
  const rows = await db
    .select({ name: companies.name, slug: companies.slug })
    .from(companies)
    .where(
      sql`lower(${companies.name}) >= ${from} AND lower(${companies.name}) < ${`${from}\uffff`}`,
    )
    .orderBy(companies.name)
    .limit(limit + 1);
  return { companies: rows.slice(0, limit), truncated: rows.length > limit };
}

/** Title words for `/v1/titles`, from the observed-token table (raw words, not FTS stems). */
export async function listTitleTokens(
  db: Db,
  { prefix, limit }: { prefix?: string; limit: number },
): Promise<{ titles: string[]; truncated: boolean }> {
  const from = (prefix ?? "").trim().toLowerCase();
  const rows = await db
    .select({ token: titleTokens.token })
    .from(titleTokens)
    .where(sql`${titleTokens.token} >= ${from} AND ${titleTokens.token} < ${`${from}\uffff`}`)
    .orderBy(titleTokens.token)
    .limit(limit + 1);
  return {
    titles: rows.slice(0, limit).map((r) => r.token),
    truncated: rows.length > limit,
  };
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

/**
 * Sources with their freshness and `lastPostingsAt`: the last run that listed any postings, or null.
 * `lastListedAt` cannot say this (a complete empty listing counts as listed), so sync reads this
 * to back off boards that stay empty. Runs are pruned after 30 days, so an older board reads as null.
 */
export async function listSources(db: Db, now = Math.floor(Date.now() / 1000)) {
  const rows = await db
    .select({
      ...getTableColumns(sources),
      // Written as `sources.id`, not interpolated: an interpolated column renders bare, and `id` would
      // resolve to the subquery's own runs.id.
      lastPostingsAt: sql<
        number | null
      >`(SELECT max(r.started_at) FROM runs r WHERE r.source_id = sources.id AND r.seen > 0)`,
    })
    .from(sources)
    .orderBy(sources.id);
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
