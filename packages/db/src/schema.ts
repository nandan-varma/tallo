import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** One configured recruiting surface. Mirrors the repo's source config; written when a run starts. */
export const sources = sqliteTable("sources", {
  id: text().primaryKey(),
  platform: text().notNull(),
  key: text().notNull(),
  company: text().notNull(),
  companySlug: text("company_slug").notNull(),
  params: text({ mode: "json" }).$type<Record<string, string | number | boolean>>().notNull(),
  lastRunAt: integer("last_run_at"),
  /** Last run that listed the whole board. Basis for staleness. */
  lastCompleteRunAt: integer("last_complete_run_at"),
  lastStatus: text("last_status"),
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
    issues: text({ mode: "json" }).$type<{ code: string; message: string; url?: string; postingId?: string }[]>(),
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
    /** Tri-state heuristics: 1 yes, 0 no, NULL unknown. */
    isUs: integer("is_us"),
    isTech: integer("is_tech"),
    classifierVersion: integer("classifier_version").notNull(),
    department: text(),
    team: text(),
    employmentType: text("employment_type"),
    requisitionId: text("requisition_id"),
    postedAt: integer("posted_at"),
    sourceUpdatedAt: integer("source_updated_at"),
    expiresAt: integer("expires_at"),
    salaryMinAnnual: real("salary_min_annual"),
    salaryMaxAnnual: real("salary_max_annual"),
    salaryCurrency: text("salary_currency"),
    expMinYears: real("exp_min_years"),
    expMaxYears: real("exp_max_years"),
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
    /** 1 when heuristics are confident the job is out of scope (non-US or non-tech). */
    hidden: integer().notNull().default(0),
  },
  (t) => [
    uniqueIndex("jobs_source_posting_idx").on(t.sourceId, t.postingId),
    index("jobs_feed_idx")
      .on(sql`${t.sortAt} desc`, sql`${t.id} desc`)
      .where(sql`${t.closedAt} IS NULL AND ${t.hidden} = 0`),
    index("jobs_company_idx")
      .on(t.companySlug, sql`${t.sortAt} desc`)
      .where(sql`${t.closedAt} IS NULL AND ${t.hidden} = 0`),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
