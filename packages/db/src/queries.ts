import type { SQL } from "drizzle-orm";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import { jobs, sources } from "./schema.ts";

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
};

export async function searchJobs(db: Db, input: Search, now = Math.floor(Date.now() / 1000)) {
  const match = input.q ? ftsQuery(input.q) : undefined;
  const where: (SQL | undefined)[] = [
    sql`${jobs.closedAt} IS NULL`,
    input.all ? undefined : sql`${jobs.hidden} = 0`,
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

export async function getJob(db: Db, id: number) {
  return (await db.select().from(jobs).where(eq(jobs.id, id)).limit(1))[0];
}

export async function listSources(db: Db) {
  return db.select().from(sources).orderBy(sources.id);
}
