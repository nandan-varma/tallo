import { describe, expect, it } from "vitest";
import { type D1Like, measure, meterD1 } from "../src/meter.ts";

interface Answer {
  results: unknown[];
  /** What raw() gives, one array per row; with `columns`, raw({ columnNames: true }) puts them first. Defaults to results. */
  rawRows?: unknown[][];
  columns?: string[];
  meta?: { rows_read?: number; rows_written?: number };
}

/** A D1 stand-in: every statement answers with the rows and meta given for its SQL text. Tests only. */
function fakeD1(answers: Record<string, Answer>) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const statement = (sql: string, values: unknown[]) => {
    const answer = answers[sql] as Answer;
    return {
      bind: (...more: unknown[]) => statement(sql, [...values, ...more]),
      all: async () => {
        calls.push({ sql, values });
        return answer;
      },
      run: async () => ({ results: [], meta: answer.meta }),
      first: async () => {
        calls.push({ sql, values });
        return answer.results[0] ?? null;
      },
      raw: async (options?: { columnNames?: boolean }) => {
        calls.push({ sql, values });
        const rows = answer.rawRows ?? answer.results;
        return options?.columnNames && answer.columns ? [answer.columns, ...rows] : rows;
      },
    };
  };
  const d1 = {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: { all: () => Promise<Answer> }[]) => {
      const out: Answer[] = [];
      for (const s of statements) out.push(await s.all());
      return out;
    },
  };
  return { d1: d1 as unknown as D1Like, calls };
}

describe("meterD1", () => {
  it("adds each statement's D1 meta and rows to the request being measured", async () => {
    const { d1 } = fakeD1({
      "SELECT 1": { results: [{ a: 1 }, { a: 2 }], meta: { rows_read: 40, rows_written: 0 } },
      "UPDATE x": { results: [], meta: { rows_read: 2, rows_written: 3 } },
    });
    const db = meterD1(d1);

    const cost = await measure(async () => {
      await db.prepare("SELECT 1").bind().all();
      await db.prepare("UPDATE x").run();
    });

    expect(cost).toEqual({ statements: 2, rows_read: 42, rows_written: 3, rows_returned: 2 });
  });

  it("reads a raw() select through all() once its columns are known to be distinct: D1's meta, rows as arrays", async () => {
    const { d1, calls } = fakeD1({
      "SELECT 2": {
        results: [
          { id: 1, name: "a" },
          { id: 2, name: "b" },
        ],
        rawRows: [
          [1, "a"],
          [2, "b"],
        ],
        columns: ["id", "name"],
        meta: { rows_read: 9 },
      },
    });
    const db = meterD1(d1);
    const read = async () => {
      let rows: unknown[] = [];
      const cost = await measure(async () => {
        rows = await db.prepare("SELECT 2").bind().raw();
      });
      return { rows, cost };
    };

    // The first call learns the names through raw(): the original data, no meta.
    const first = await read();
    expect(first.cost.rows_read).toBeNull();
    // After that the measured path gives the same rows with D1's meta.
    const second = await read();
    expect(second.rows).toEqual(first.rows);
    expect(second.rows).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
    expect(second.cost).toEqual({
      statements: 1,
      rows_read: 9,
      rows_written: null,
      rows_returned: 2,
    });
    expect(calls.filter((c) => c.sql === "SELECT 2")).toHaveLength(2);
  });

  it("never drops a duplicate column name: such a statement keeps D1's raw() answer, rows_read unknown", async () => {
    // `SELECT jobs.id, sources.id`: all() would collapse the two ids into one key.
    const answer: Answer = {
      results: [{ id: 2 }],
      rawRows: [[1, 2]],
      columns: ["id", "id"],
      meta: { rows_read: 9 },
    };
    const { d1 } = fakeD1({ "SELECT 9": answer });
    const db = meterD1(d1);
    const run = async () => {
      let rows: unknown[] = [];
      const cost = await measure(async () => {
        rows = await db.prepare("SELECT 9").bind().raw();
      });
      return { rows, cost };
    };

    const unmeasured = await db.prepare("SELECT 9").bind().raw();
    for (const call of [await run(), await run(), await run()]) {
      expect(call.rows).toEqual(unmeasured);
      expect(call.rows).toEqual([[1, 2]]);
      expect(call.cost.rows_read).toBeNull();
    }
  });

  it("leaves raw() with options, and raw() outside a measured request, as D1 answers it", async () => {
    const { d1 } = fakeD1({ "SELECT 8": { results: [[1], [2]] } });
    const db = meterD1(d1);

    expect(await db.prepare("SELECT 8").bind().raw()).toEqual([[1], [2]]);
    const cost = await measure(async () => {
      await db.prepare("SELECT 8").bind().raw({ columnNames: true });
    });
    expect(cost).toEqual({ statements: 1, rows_read: null, rows_written: null, rows_returned: 2 });
  });

  it("reads a batch's meta per statement, and runs the wrapped statements it was given", async () => {
    const { d1, calls } = fakeD1({
      "SELECT 3": { results: [{ a: 1 }], meta: { rows_read: 5 } },
      "SELECT 4": { results: [], meta: { rows_read: 7 } },
    });
    const db = meterD1(d1);

    const cost = await measure(async () => {
      await db.batch([db.prepare("SELECT 3").bind(), db.prepare("SELECT 4").bind()]);
    });

    expect(cost.statements).toBe(2);
    expect(cost.rows_read).toBe(12);
    expect(calls.map((c) => c.sql)).toEqual(["SELECT 3", "SELECT 4"]);
  });

  it("records nothing outside a measured request, and passes the call through", async () => {
    const { d1 } = fakeD1({ "SELECT 5": { results: [{ a: 1 }], meta: { rows_read: 1 } } });
    const rows = await meterD1(d1).prepare("SELECT 5").bind().all();
    expect(rows.results).toEqual([{ a: 1 }]);

    const cost = await measure(async () => undefined);
    expect(cost).toEqual({ statements: 0, rows_read: null, rows_written: null, rows_returned: 0 });
  });

  it("keeps each request's cost apart when two run at once", async () => {
    const { d1 } = fakeD1({
      "SELECT 6": { results: [{ a: 1 }], meta: { rows_read: 1 } },
      "SELECT 7": { results: [{ a: 1 }, { a: 2 }], meta: { rows_read: 10 } },
    });
    const db = meterD1(d1);
    const [first, second] = await Promise.all([
      measure(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await db.prepare("SELECT 6").bind().all();
      }),
      measure(async () => {
        await db.prepare("SELECT 7").bind().all();
      }),
    ]);
    expect(first.rows_read).toBe(1);
    expect(second.rows_read).toBe(10);
  });
});
