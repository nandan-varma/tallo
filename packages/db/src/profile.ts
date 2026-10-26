import { eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { profiles } from "./schema.ts";

export interface Profile {
  resume: string;
  profile: string;
  updatedAt: number;
}

/** v1 has one user; the key keeps the table ready for more without a migration. */
export const DEFAULT_USER = "me";

export async function getProfile(db: Db, userId = DEFAULT_USER): Promise<Profile | null> {
  const [row] = await db
    .select({
      resume: profiles.resume,
      profile: profiles.profile,
      updatedAt: profiles.updatedAt,
    })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  return row ?? null;
}

/** Personal data lives outside the catalog write path (`ingest.ts`), so it has its own writer. */
export async function saveProfile(
  db: Db,
  input: { resume: string; profile: string },
  userId = DEFAULT_USER,
  now = Math.floor(Date.now() / 1000),
): Promise<Profile> {
  const values = { userId, resume: input.resume, profile: input.profile, updatedAt: now };
  await db
    .insert(profiles)
    .values(values)
    .onConflictDoUpdate({
      target: profiles.userId,
      set: { resume: values.resume, profile: values.profile, updatedAt: now },
    });
  return { resume: values.resume, profile: values.profile, updatedAt: now };
}
