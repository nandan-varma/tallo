import { type ResumeDoc, type ResumeRecord, resumeDocSchema } from "@tallo/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db.ts";
import { DEFAULT_USER } from "./profile.ts";
import { jobs, resumes } from "./schema.ts";

/** `job_id` 0 is the base resume; a posting id is the copy tailored to it. */
const BASE = 0;
const keyOf = (jobId: number | null) => jobId ?? BASE;

export async function getResume(
  db: Db,
  jobId: number | null = null,
  userId = DEFAULT_USER,
): Promise<ResumeRecord | null> {
  const [row] = await db
    .select({ doc: resumes.doc, updatedAt: resumes.updatedAt })
    .from(resumes)
    .where(and(eq(resumes.userId, userId), eq(resumes.jobId, keyOf(jobId))))
    .limit(1);
  if (!row) return null;
  return { jobId, doc: resumeDocSchema.parse(row.doc), updatedAt: row.updatedAt };
}

/** Personal data lives outside the catalog write path (`ingest.ts`), so it has its own writer. */
export async function saveResume(
  db: Db,
  doc: ResumeDoc,
  jobId: number | null = null,
  userId = DEFAULT_USER,
  now = Math.floor(Date.now() / 1000),
): Promise<ResumeRecord> {
  await db
    .insert(resumes)
    .values({ userId, jobId: keyOf(jobId), doc, updatedAt: now })
    .onConflictDoUpdate({ target: [resumes.userId, resumes.jobId], set: { doc, updatedAt: now } });
  return { jobId, doc, updatedAt: now };
}

export async function deleteResume(db: Db, jobId: number, userId = DEFAULT_USER): Promise<void> {
  await db.delete(resumes).where(and(eq(resumes.userId, userId), eq(resumes.jobId, jobId)));
}

/** The base resume and every tailored copy, newest first, with each posting's title when it still exists. */
export async function listResumes(db: Db, userId = DEFAULT_USER) {
  const rows = await db
    .select({ jobId: resumes.jobId, updatedAt: resumes.updatedAt })
    .from(resumes)
    .where(eq(resumes.userId, userId))
    .orderBy(desc(resumes.updatedAt));
  const ids = rows.map((row) => row.jobId).filter((id) => id !== BASE);
  const postings = ids.length
    ? await db
        .select({ id: jobs.id, title: jobs.title, company: jobs.company })
        .from(jobs)
        .where(inArray(jobs.id, ids))
    : [];
  const byId = new Map(postings.map((posting) => [posting.id, posting]));
  return rows.map((row) => {
    const posting = byId.get(row.jobId);
    return {
      jobId: row.jobId === BASE ? null : row.jobId,
      title: posting?.title ?? null,
      company: posting?.company ?? null,
      updatedAt: row.updatedAt,
    };
  });
}
