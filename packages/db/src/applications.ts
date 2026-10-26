import {
  type Application,
  type ApplicationStatus,
  applicationStatusSchema,
} from "@tallo/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { DEFAULT_USER } from "./profile.ts";
import { applications, jobs } from "./schema.ts";

type Row = typeof applications.$inferSelect;

const toApplication = (row: Row): Application => ({
  jobId: row.jobId,
  status: applicationStatusSchema.parse(row.status),
  note: row.note,
  title: row.title,
  company: row.company,
  location: row.location,
  applyUrl: row.applyUrl,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  appliedAt: row.appliedAt,
});

const keyOf = (userId: string, jobId: number) =>
  and(eq(applications.userId, userId), eq(applications.jobId, jobId));

/** Newest first by last change. */
export async function listApplications(db: Db, userId = DEFAULT_USER): Promise<Application[]> {
  const rows = await db
    .select()
    .from(applications)
    .where(eq(applications.userId, userId))
    .orderBy(desc(applications.updatedAt));
  return rows.map(toApplication);
}

/**
 * Tracks a posting or moves it to another status. The first call copies the posting's title, company, place and
 * apply address; later calls change only status, note and times. Returns null when the posting does not exist.
 */
export async function setApplication(
  db: Db,
  jobId: number,
  input: { status: ApplicationStatus; note?: string },
  userId = DEFAULT_USER,
  now = Math.floor(Date.now() / 1000),
): Promise<Application | null> {
  const [existing] = await db.select().from(applications).where(keyOf(userId, jobId)).limit(1);
  if (existing) {
    const changes = {
      status: input.status,
      note: input.note ?? existing.note,
      updatedAt: now,
      appliedAt:
        input.status === "applied" && existing.appliedAt === null ? now : existing.appliedAt,
    };
    await db.update(applications).set(changes).where(keyOf(userId, jobId));
    return toApplication({ ...existing, ...changes });
  }

  const [posting] = await db
    .select({
      title: jobs.title,
      company: jobs.company,
      locationText: jobs.locationText,
      applyUrl: jobs.applyUrl,
      url: jobs.url,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!posting) return null;

  const row: Row = {
    userId,
    jobId,
    status: input.status,
    note: input.note ?? "",
    title: posting.title,
    company: posting.company,
    location: posting.locationText,
    applyUrl: posting.applyUrl ?? posting.url,
    createdAt: now,
    updatedAt: now,
    appliedAt: input.status === "applied" ? now : null,
  };
  await db.insert(applications).values(row);
  return toApplication(row);
}

export async function removeApplication(
  db: Db,
  jobId: number,
  userId = DEFAULT_USER,
): Promise<void> {
  await db.delete(applications).where(keyOf(userId, jobId));
}
