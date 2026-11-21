import { describe, expect, it } from "vitest";
import { companiesQuery, variantsQuery } from "../src/index.ts";
import { queryPlan, testDb } from "../src/testing.ts";

/** A plan step that reads a whole table. Any of these on a public read is the cost the index work removes. */
const scans = (plan: string[]) => plan.filter((step) => /^SCAN\b/.test(step));

describe("query plans", () => {
  it("listVariants seeks the canonical row and its siblings by index, never a scan", async () => {
    const db = testDb();
    const plan = queryPlan(db, variantsQuery(db, { id: 7, dupOf: null }));

    expect(scans(plan)).toEqual([]);
    expect(plan).toContain("SEARCH jobs USING INTEGER PRIMARY KEY (rowid=?)");
    expect(plan.join("\n")).toContain("SEARCH jobs USING INDEX jobs_dup_of_idx (dup_of=?)");
  });

  it("the companies prefix range is an index seek on lower(name)", async () => {
    const db = testDb();
    const plan = queryPlan(db, companiesQuery(db, { prefix: "goo", limit: 10 }));

    expect(scans(plan)).toEqual([]);
    expect(plan.join("\n")).toContain("USING INDEX companies_lower_name_idx");
  });
});
