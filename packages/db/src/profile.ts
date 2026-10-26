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
  input: { profile: string },
  userId = DEFAULT_USER,
  now = Math.floor(Date.now() / 1000),
): Promise<Profile> {
  // `resume` is the legacy pasted text: new rows start empty and updates leave it alone.
  await db
    .insert(profiles)
    .values({ userId, resume: "", profile: input.profile, updatedAt: now })
    .onConflictDoUpdate({
      target: profiles.userId,
      set: { profile: input.profile, updatedAt: now },
    });
  return {
    resume: (await getProfile(db, userId))?.resume ?? "",
    profile: input.profile,
    updatedAt: now,
  };
}
