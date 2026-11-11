import { TIERS } from "@tallo/contracts";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** One configured recruiting surface. Mirrors the repo's source config; written when a run starts. */
export const sources = sqliteTable(
  "sources",
  {
    id: text().primaryKey(),
    platform: text().notNull(),
    key: text().notNull(),
    company: text().notNull(),
    companySlug: text("company_slug").notNull(),
    params: text({ mode: "json" }).$type<Record<string, string | number | boolean>>().notNull(),
    lastRunAt: integer("last_run_at"),
    /** Last run that listed the whole board. */
    lastCompleteRunAt: integer("last_complete_run_at"),
    /** Last run that listed any postings, complete or not. Basis for staleness. */
    lastListedAt: integer("last_listed_at"),
    lastStatus: text("last_status"),
    /** Consecutive runs whose listing 404'd. Any other outcome resets it to 0. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /**
     * Failed or partial runs in a row (any run that did not list completely). A complete run resets it.
     * Drives the back-off (contracts `schedule.ts`).
     */
    failureCount: integer("failure_count").notNull().default(0),
    /** `dead` boards are skipped by sync unless asked; a complete listing revives them. */
    status: text({ enum: ["active", "dead"] })
      .notNull()
      .default("active"),
    /** Epoch second the board is next due (0: due now). The cron claims due boards by moving this forward (a lease). */
    nextDueAt: integer("next_due_at").notNull().default(0),
    /** Collection frequency class, from the reviewed hot list. See contracts `schedule.ts`. */
    tier: text({ enum: TIERS }).notNull().default("rare"),
  },
  (t) => [index("sources_next_due_idx").on(t.nextDueAt)],
);

/**
 * The hourly regroup's cursor: one row (`id` 1). `checked_at` is when the last complete incremental pass ran; the
 * next pass reads everything written or aged since then, less a margin (ingest.ts). Written only by that pass.
 */
export const regroupState = sqliteTable("regroup_state", {
  id: integer().primaryKey(),
  checkedAt: integer("checked_at").notNull(),
});

/** Bounded operational history: what ran where and when. Old rows are pruned. */
export const runs = sqliteTable(
  "runs",
  {
    id: text().primaryKey(),
    sourceId: text("source_id").notNull(),
    runnerId: text("runner_id").notNull(),
    collectorVersion: text("collector_version").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    status: text({ enum: ["running", "complete", "partial"] }).notNull(),
    requests: integer(),
    seen: integer(),
    added: integer().notNull().default(0),
    changed: integer().notNull().default(0),
    closed: integer(),
    reopened: integer(),
    rawKey: text("raw_key"),
    rawUploaded: integer("raw_uploaded").notNull().default(1),
    issues: text({ mode: "json" }).$type<
      { code: string; message: string; url?: string; postingId?: string }[]
    >(),
  },
  (t) => [
    index("runs_source_idx").on(t.sourceId, t.startedAt),
    // Retention reads runs by age (expired history, abandoned packs). Without it each hourly prune scans every run.
    index("runs_started_idx").on(t.startedAt),
    // Only the finalized, uploaded packs: the rows retention ranks per source. A partial index keeps the
    // ranking off the rows that have no pack (most of the table) and costs one entry per pack.
    index("runs_pack_idx")
      .on(t.sourceId, t.startedAt, t.id)
      .where(sql`${t.rawKey} IS NOT NULL AND ${t.rawUploaded} = 1 AND ${t.status} != 'running'`),
  ],
);

/**
 * Lean, hot catalog row: facts and blob references only. The description lives in object
 * storage (`jd_hash`); raw source payloads live in run packs.
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    sourceId: text("source_id").notNull(),
    postingId: text("posting_id").notNull(),
    company: text().notNull(),
    companySlug: text("company_slug").notNull(),
    title: text().notNull(),
    url: text(),
    applyUrl: text("apply_url"),
    locationText: text("location_text"),
    city: text(),
    region: text(),
    countryCode: text("country_code"),
    workMode: text("work_mode", { enum: ["remote", "hybrid", "onsite"] }),
    department: text(),
    team: text(),
    employmentType: text("employment_type"),
    requisitionId: text("requisition_id"),
    postedAt: integer("posted_at"),
    sourceUpdatedAt: integer("source_updated_at"),
    expiresAt: integer("expires_at"),
    excerpt: text().notNull(),
    jdHash: text("jd_hash").notNull(),
    jdBytes: integer("jd_bytes").notNull(),
    sourceHash: text("source_hash").notNull(),
    /** Rich typed detail: all locations, pay components, experience, extras. */
    facts: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Stable feed order: posted time, else first seen. */
    sortAt: integer("sort_at").notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** Consecutive complete runs that did not list this job. */
    absentRuns: integer("absent_runs").notNull().default(0),
    closedAt: integer("closed_at"),
    /** Groups listings of one posting (catalog `dedupeKey`). NULL until backfilled. */
    dedupeKey: text("dedupe_key"),
    /** Canonical row of the open group (lowest id). NULL for canonical and ungrouped rows. */
    dupOf: integer("dup_of"),
  },
  (t) => [
    uniqueIndex("jobs_source_posting_idx").on(t.sourceId, t.postingId),
    index("jobs_dedupe_idx").on(t.dedupeKey).where(sql`${t.closedAt} IS NULL`),
    index("jobs_dup_of_idx").on(t.dupOf).where(sql`${t.dupOf} IS NOT NULL`),
    // The hourly regroup finds rows whose grouping changed by updated_at (a regroup input or a reopen or
    // closure bumps it; see ingest.ts). Every index costs a write per row it covers, so keep this list short.
    index("jobs_updated_idx").on(t.updatedAt),
    // Description lookup: purge asks which of a batch of hashes are still referenced. Without it each
    // purge pass scans the whole table. Costs one index write per new job (and per description change).
    index("jobs_jd_hash_idx").on(t.jdHash),
    // The 30-day purge selects closed rows only; open rows (the vast majority) are not indexed.
    index("jobs_closed_idx").on(t.closedAt).where(sql`${t.closedAt} IS NOT NULL`),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
