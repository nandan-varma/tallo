import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { Db } from "./db.ts";
import { payOf, visibleJobs } from "./queries.ts";
import * as schema from "./schema.ts";

const MIGRATIONS = new URL("../drizzle/", import.meta.url);

/**
 * Write cost as D1 bills it, approximately: `rows` counts every row changed, triggers included (SQLite's
 * total_changes); `indexEntries` counts index b-tree entries written (changed rows x indexes the statement
 * opens for writing, read from EXPLAIN). FTS shadow-table writes are not visible here.
 */
export interface WriteCost {
  rows: number;
  indexEntries: number;
}

const costs = new WeakMap<Db, WriteCost>();
const reads = new WeakMap<Db, { rows: number; queries: number }>();
const engines = new WeakMap<Db, DatabaseSync>();

/**
 * A D1-shaped binding over the same in-memory SQLite as `db`: what drizzle's D1 driver talks to in production (`all`,
 * `run`, `first`, `raw`, `batch`, with D1's `meta`). The meta here is an approximation (rows returned count as rows
 * read; changes count as rows written), enough to test the plumbing. Tests only.
 */
export function d1Like(db: Db): unknown {
  const engine = engines.get(db);
  if (!engine) throw new Error("d1Like needs a db from testDb()");
  const statement = (sql: string, values: unknown[]): Record<string, unknown> => ({
    bind: (...more: unknown[]) => statement(sql, [...values, ...more]),
    all: async () => {
      const results = engine.prepare(sql).all(...(values as never[]));
      return { results, success: true, meta: { rows_read: results.length, rows_written: 0 } };
    },
    run: async () => {
      const { changes } = engine.prepare(sql).run(...(values as never[]));
      return { results: [], success: true, meta: { rows_read: 0, rows_written: Number(changes) } };
    },
    first: async (column?: string) => {
      const row = engine.prepare(sql).get(...(values as never[])) ?? null;
      return column === undefined || row === null ? row : (row[column] ?? null);
    },
    raw: async () => {
      const stmt = engine.prepare(sql);
      stmt.setReturnArrays(true);
      return stmt.all(...(values as never[]));
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: { all: () => Promise<unknown> }[]) => {
      const out = [];
      for (const s of statements) out.push(await s.all());
      return out;
    },
  };
}

/**
 * SQLite's own plan for a query builder's SQL (`EXPLAIN QUERY PLAN`), one line per step. Tests use it to prove a query
 * seeks an index instead of scanning a table. Tests only.
 */
export function queryPlan(
  db: Db,
  query: { toSQL(): { sql: string; params: unknown[] } },
): string[] {
  const engine = engines.get(db);
  if (!engine) throw new Error("queryPlan needs a db from testDb()");
  const { sql, params } = query.toSQL();
  return engine
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(params as never[]))
    .map((row) => String(row.detail));
}

/** Rows materialized by reads, including cursor/candidate reads; a proxy for D1 response work. */
export const readCost = (db: Db) => ({ ...(reads.get(db) ?? { rows: 0, queries: 0 }) });

/** Cumulative write cost of everything run through a `testDb()` instance. Tests only. */
export const writeCost = (db: Db): WriteCost => ({
  ...(costs.get(db) ?? { rows: 0, indexEntries: 0 }),
});

/** In-memory SQLite behind Drizzle's proxy driver, with every migration applied. Tests only. */
export function testDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(new URL(file, MIGRATIONS), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  const cost: WriteCost = { rows: 0, indexEntries: 0 };
  const read = { rows: 0, queries: 0 };
  const totalChanges = () => Number(sqlite.prepare("SELECT total_changes() AS n").get()?.n);
  const indexRoots = () =>
    new Set(
      sqlite
        .prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'index' AND rootpage > 0")
        .all()
        .map((r) => Number(r.rootpage)),
    );
  const run = (sql: string, params: unknown[], method: string) => {
    const stmt = sqlite.prepare(sql);
    if (method === "run") {
      const before = totalChanges();
      const roots = indexRoots();
      const opened = sqlite
        .prepare(`EXPLAIN ${sql}`)
        .all(...(params as never[]))
        .filter((op) => op.opcode === "OpenWrite" && roots.has(Number(op.p2))).length;
      const { changes } = stmt.run(...(params as never[]));
      cost.rows += totalChanges() - before;
      cost.indexEntries += Number(changes) * opened;
      return { rows: [] };
    }
    stmt.setReturnArrays(true);
    const rows = stmt.all(...(params as never[])) as unknown as unknown[][];
    read.rows += rows.length;
    read.queries++;
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  };
  const db = drizzle(
    async (sql, params, method) => run(sql, params, method),
    async (queries) => {
      sqlite.exec("BEGIN");
      try {
        const out = queries.map((q) => run(q.sql, q.params, q.method));
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    { schema },
  );
  costs.set(db, cost);
  reads.set(db, read);
  engines.set(db, sqlite);
  return db;
}

/** One job row by id, with its stored facts. Tests only. */
export async function getJob(db: Db, id: number) {
  const row = (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1))[0];
  return row ? { ...row, pay: payOf(row.facts) } : undefined;
}

/**
 * What a default search shows (`visibleJobs`), newest first, with `variants` (open listings of the posting, this row
 * included). The visibility oracle for the ingest and dedupe tests. Tests only.
 */
export async function visibleList(
  db: Db,
  { limit, includeStale }: { limit: number; includeStale?: boolean },
  now = Math.floor(Date.now() / 1000),
) {
  const rows = await db
    .select({
      ...getTableColumns(schema.jobs),
      variants: sql<number>`(SELECT count(*) FROM jobs AS dup WHERE dup.dup_of = "jobs"."id" AND dup.closed_at IS NULL) + 1`,
    })
    .from(schema.jobs)
    .where(and(...visibleJobs(now, { includeStale })))
    .orderBy(desc(schema.jobs.sortAt), desc(schema.jobs.id))
    .limit(limit);
  return { jobs: rows.map((row) => ({ ...row, pay: payOf(row.facts) })) };
}
