import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import type * as schema from "./schema.ts";

/** D1 in production, a SQLite proxy in tests and tooling. Both are async and support `batch`. */
export type Db = DrizzleD1Database<typeof schema> | SqliteRemoteDatabase<typeof schema>;

/** The ids are numeric and server-generated, so sending them as one JSON param is safe and
 * sidesteps D1's 100-bound-parameter limit. */
export const CHUNK = 2000;

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
