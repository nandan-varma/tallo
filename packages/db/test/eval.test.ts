import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "../eval/cases.ts";
import { seedFixture } from "../eval/fixture.ts";
import { runEval, table } from "../eval/harness.ts";
import type { Db } from "../src/db.ts";
import { testDb } from "../src/testing.ts";

/** The standing search evaluation on the in-memory fixture (the production run is `pnpm --filter @tallo/db eval -- --prod`). */
describe("search evaluation on the fixture", () => {
  it("runs every case and keeps the fixture scores at or above their floors", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = testDb() as unknown as Db;
    await seedFixture(db, now);

    const report = await runEval(db, EVAL_CASES, { mode: "fixture", now, meter: null });

    expect(report.total.cases).toBe(EVAL_CASES.length);
    expect(report.cases.every((c) => c.returned >= 0)).toBe(true);
    expect(table(report)).toContain("TOTAL");
    expect(report.total.precision).toBeGreaterThanOrEqual(FLOOR.precision);
    expect(report.total.recall).toBeGreaterThanOrEqual(FLOOR.recall);
  });
});

/** Set just below what the fixture gives now (P@20 97%, recall 99%); a drop below these is a regression. */
const FLOOR = { precision: 0.95, recall: 0.95 };
