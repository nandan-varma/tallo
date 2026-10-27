import type { SearchSpec } from "@tallo/contracts";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** One configured recruiting surface. Mirrors the repo's source config; written when a run starts. */
export const sources = sqliteTable("sources", {
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
  /** `dead` boards are skipped by sync unless asked; a complete listing revives them. */
  status: text({ enum: ["active", "dead"] })
    .notNull()
    .default("active"),
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
  (t) => [index("runs_source_idx").on(t.sourceId, t.startedAt)],
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
    // The hourly regroup finds rows written since the last pass by updated_at (closure bumps it too).
    index("jobs_updated_idx").on(t.updatedAt),
    index("jobs_feed_idx")
      .on(sql`${t.sortAt} desc`, sql`${t.id} desc`)
      .where(sql`${t.closedAt} IS NULL`),
    index("jobs_company_idx")
      .on(t.companySlug, sql`${t.sortAt} desc`)
      .where(sql`${t.closedAt} IS NULL`),
  ],
);

export type JobRow = typeof jobs.$inferSelect;

/**
 * Personal layer (CLAUDE.md rule 5): free-text notes the person gives the assistant (`profile`), keyed by user. Never joined into the shared catalog tables. Search results and chat are not stored anywhere.
 */
export const profiles = sqliteTable("profiles", {
  userId: text("user_id").primaryKey(),
  profile: text().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Personal layer: the structured resume the user builds. One base copy (`job_id` 0) and one copy per posting
 * it was tailored for. `job_id` is a plain number, not a foreign key: a copy outlives its posting being closed
 * or purged. `doc` is the JSON of `ResumeDoc` (words and style), validated at the API edge.
 */
export const resumes = sqliteTable(
  "resumes",
  {
    userId: text("user_id").notNull(),
    jobId: integer("job_id").notNull().default(0),
    doc: text({ mode: "json" }).$type<unknown>().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.jobId] })],
);

/**
 * Personal layer: the application tracker, one row per posting the person has saved or applied to, keyed by user.
 * `job_id` is a plain number, not a foreign key: the tracker outlives the posting being closed or purged, so the
 * title, company, place and apply address are copied in when the role is first tracked.
 */
export const applications = sqliteTable(
  "applications",
  {
    userId: text("user_id").notNull(),
    jobId: integer("job_id").notNull(),
    status: text().notNull(),
    note: text().notNull().default(""),
    title: text().notNull(),
    company: text().notNull(),
    location: text(),
    applyUrl: text("apply_url"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    appliedAt: integer("applied_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.jobId] })],
);

/**
 * Personal layer: a saved search (the title phrases and places the assistant built), keyed by user. `spec` is the
 * JSON of `SearchSpec`. `seen_at` is when the person last ran it; roles posted after that count as new.
 */
export const searches = sqliteTable(
  "searches",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    name: text().notNull(),
    spec: text({ mode: "json" }).$type<SearchSpec>().notNull(),
    createdAt: integer("created_at").notNull(),
    seenAt: integer("seen_at").notNull(),
  },
  (t) => [index("searches_user_idx").on(t.userId)],
);
