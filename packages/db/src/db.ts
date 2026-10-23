import type { BatchItem } from "drizzle-orm/batch";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema.ts";

// biome-ignore lint/suspicious/noExplicitAny: D1 and the SQLite proxy differ only in their run-result type.
type AnyRunResult = any;

/**
 * D1 in production, a SQLite proxy in tests and tooling. Both are async and support `batch`
 * (D1 has no interactive transactions, so every multi-statement write goes through it).
 */
export type Db = BaseSQLiteDatabase<"async", AnyRunResult, typeof schema> & {
  batch(queries: readonly [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]): Promise<unknown>;
};

/** Atomically run one or more statements. */
export const batch = (db: Db, statements: BatchItem<"sqlite">[]): Promise<unknown> =>
  db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

/** The ids are numeric and server-generated, so sending them as one JSON param is safe and
 * sidesteps D1's 100-bound-parameter limit. */
export const CHUNK = 2000;

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
