import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What one request cost the database. `rows_read` and `rows_written` are D1's own `meta` figures, summed over the
 * statements that reported them; null when none did. D1's `raw()` (which drizzle's select path uses) returns no meta, so
 * inside a measured request `raw()` runs through `all()` to get it (see `wrapStatement`). `rows_returned` is what the
 * driver handed back.
 */
export interface Cost {
  statements: number;
  rows_read: number | null;
  rows_written: number | null;
  rows_returned: number;
}

const scope = new AsyncLocalStorage<Cost>();

/** Runs `next` with a fresh cost: every D1 call it makes (directly or through drizzle) adds to the returned object. */
export async function measure(next: () => Promise<unknown>): Promise<Cost> {
  const cost: Cost = { statements: 0, rows_read: null, rows_written: null, rows_returned: 0 };
  await scope.run(cost, next);
  return cost;
}

interface Meta {
  rows_read?: number;
  rows_written?: number;
}

function record(meta: Meta | undefined, returned: number) {
  const cost = scope.getStore();
  if (!cost) return;
  cost.statements += 1;
  cost.rows_returned += returned;
  if (typeof meta?.rows_read === "number") cost.rows_read = (cost.rows_read ?? 0) + meta.rows_read;
  if (typeof meta?.rows_written === "number") {
    cost.rows_written = (cost.rows_written ?? 0) + meta.rows_written;
  }
}

/**
 * The parts of a D1 binding the meter touches. Structural on purpose: the meter names no Workers types, so it type-checks
 * under the API's test configuration too. A real `D1Database` satisfies it.
 */
export interface D1Like {
  prepare(query: string): StatementLike;
  batch(statements: StatementLike[]): Promise<ResultLike[]>;
}

interface StatementLike {
  bind(...values: unknown[]): StatementLike;
  all(): Promise<ResultLike>;
  run(): Promise<ResultLike>;
  first(column?: string): Promise<unknown>;
  raw(options?: unknown): Promise<unknown[]>;
}

interface ResultLike {
  results?: unknown[];
  meta?: Meta;
}

/** Each wrapper statement's underlying statement, so `batch` can take the wrappers it was handed. */
const inner = new WeakMap<object, StatementLike>();

/** Per SQL text: whether its result columns are all distinctly named (true), or not (false). Unknown until seen. */
const distinct = new Map<string, boolean>();

function wrapStatement(statement: StatementLike, query: string): StatementLike {
  const wrapped: StatementLike = {
    bind: (...values: unknown[]) => wrapStatement(statement.bind(...values), query),
    all: async () => {
      const result = await statement.all();
      record(result.meta, result.results?.length ?? 0);
      return result;
    },
    run: async () => {
      const result = await statement.run();
      record(result.meta, result.results?.length ?? 0);
      return result;
    },
    first: async (column?: string) => {
      const row = await (column === undefined ? statement.first() : statement.first(column));
      record(undefined, row === null ? 0 : 1);
      return row;
    },
    raw: async (options?: unknown) => {
      // Drizzle reads every select through `raw()`, which D1 answers without meta. In a measured request a statement
      // whose result columns are known to be distinct runs through `all()` instead (same query), so `rows_read` is
      // real; its objects become the arrays `raw()` gives. An object keeps one value per name, so a statement whose
      // columns are not known to be distinct never takes that path: its first measured call reads through
      // `raw({ columnNames: true })` (the original data, rows_read stays null) to learn the names, and any duplicate or
      // unreadable shape keeps it on `raw()` for good.
      if (options !== undefined || !scope.getStore()) {
        const rows = await statement.raw(options);
        record(undefined, rows.length);
        return rows;
      }
      if (distinct.get(query) !== true) {
        if (distinct.get(query) === undefined) {
          const named = await statement.raw({ columnNames: true });
          const names = named[0];
          const ok =
            Array.isArray(names) &&
            names.length > 0 &&
            names.every((name) => typeof name === "string") &&
            new Set(names).size === names.length;
          if (Array.isArray(names)) distinct.set(query, ok);
          const rows = Array.isArray(names) ? named.slice(1) : named;
          record(undefined, rows.length);
          return rows;
        }
        const rows = await statement.raw();
        record(undefined, rows.length);
        return rows;
      }
      const result = await statement.all();
      const rows = result.results ?? [];
      record(result.meta, rows.length);
      return rows.map((row) => Object.values(row as Record<string, unknown>));
    },
  };
  inner.set(wrapped, statement);
  return wrapped;
}

/**
 * A D1 binding that reports each statement's cost to the request being measured (see `measure`). Outside a measured
 * request nothing is recorded, and the calls behave as they would on the binding itself.
 */
export function meterD1<T extends D1Like>(d1: T): T {
  return new Proxy(d1, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query), query);
      }
      if (prop === "batch") {
        return async (statements: StatementLike[]) => {
          const results = await target.batch(
            statements.map((statement) => inner.get(statement) ?? statement),
          );
          for (const result of results) record(result.meta, result.results?.length ?? 0);
          return results;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
