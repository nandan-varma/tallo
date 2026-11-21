import { describe, expect, it } from "vitest";
import { type D1Like, measure, meterD1 } from "../src/meter.ts";

interface Answer {
  results: unknown[];
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
      raw: async () => {
        calls.push({ sql, values });
        return answer.results;
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

  it("counts a raw() read as a statement and its rows, with no meta, so rows_read stays unknown", async () => {
    const { d1 } = fakeD1({ "SELECT 2": { results: [[1], [2], [3]] } });
    const db = meterD1(d1);

    const cost = await measure(async () => {
      await db.prepare("SELECT 2").bind().raw();
    });

    expect(cost).toEqual({ statements: 1, rows_read: null, rows_written: null, rows_returned: 3 });
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
