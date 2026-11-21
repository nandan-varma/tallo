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

function wrapStatement(statement: StatementLike): StatementLike {
  const wrapped: StatementLike = {
    bind: (...values: unknown[]) => wrapStatement(statement.bind(...values)),
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
      // Drizzle reads every select through `raw()`, which D1 answers without meta. In a measured request the statement
      // runs through `all()` instead (the same query and cost), so its `rows_read` is real, and each row is handed back
      // as the array `raw()` would give. That is lossless only while the result columns have distinct names (an object
      // keeps one value per name); the public reads select uniquely named columns, and a new read with two same-named columns must not run measured. `raw` options are passed through.
      if (options !== undefined || !scope.getStore()) {
        const rows = await statement.raw(options);
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
        return (query: string) => wrapStatement(target.prepare(query));
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
