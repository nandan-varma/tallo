import type { SearchSpec } from "@tallo/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { DEFAULT_USER } from "./profile.ts";
import { searches } from "./schema.ts";

/** How many searches one person can keep. */
export const MAX_SEARCHES = 20;

/** Thrown by `saveSearch` at the cap, so the API can answer 409 instead of 500. */
export class SearchLimitError extends Error {}

export interface SearchRow {
  id: number;
  name: string;
  spec: SearchSpec;
  createdAt: number;
  seenAt: number;
}

/** The spec as a comparable string: case, spaces and order do not make a different search. */
const specKey = (spec: SearchSpec) =>
  JSON.stringify({
    queries: spec.queries.map((q) => q.trim().toLowerCase()).sort(),
    companies: (spec.companies ?? []).map((c) => c.trim().toLowerCase()).sort(),
    locations: (spec.locations ?? []).map((l) => l.trim().toLowerCase()).sort(),
  });

const toRow = (row: typeof searches.$inferSelect): SearchRow => ({
  id: row.id,
  name: row.name,
  spec: row.spec,
  createdAt: row.createdAt,
  seenAt: row.seenAt,
});

/** Newest first. */
export async function listSearchRows(db: Db, userId = DEFAULT_USER): Promise<SearchRow[]> {
  const rows = await db
    .select()
    .from(searches)
    .where(eq(searches.userId, userId))
    .orderBy(desc(searches.createdAt), desc(searches.id));
  return rows.map(toRow);
}

/**
 * Keeps a search. Saving the same spec again returns the row already kept, unchanged. Throws when the person
 * already keeps `MAX_SEARCHES` searches.
 */
export async function saveSearch(
  db: Db,
  input: { name: string; spec: SearchSpec },
  userId = DEFAULT_USER,
  now = Math.floor(Date.now() / 1000),
): Promise<SearchRow> {
  const rows = await listSearchRows(db, userId);
  const key = specKey(input.spec);
  const same = rows.find((row) => specKey(row.spec) === key);
  if (same) return same;
  if (rows.length >= MAX_SEARCHES) {
    throw new SearchLimitError(`You can keep up to ${MAX_SEARCHES} searches. Remove one first.`);
  }

  const [row] = await db
    .insert(searches)
    .values({ userId, name: input.name, spec: input.spec, createdAt: now, seenAt: now })
    .returning();
  if (!row) throw new Error("The search was not saved.");
  return toRow(row);
}

/** Marks a search as run now: roles posted after this moment count as new from then on. */
export async function markSearchSeen(
  db: Db,
  id: number,
  userId = DEFAULT_USER,
  now = Math.floor(Date.now() / 1000),
): Promise<SearchRow | null> {
  const [row] = await db
    .update(searches)
    .set({ seenAt: now })
    .where(and(eq(searches.id, id), eq(searches.userId, userId)))
    .returning();
  return row ? toRow(row) : null;
}

export async function removeSearch(db: Db, id: number, userId = DEFAULT_USER): Promise<void> {
  await db.delete(searches).where(and(eq(searches.id, id), eq(searches.userId, userId)));
}
