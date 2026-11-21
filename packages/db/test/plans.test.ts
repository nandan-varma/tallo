import { describe, expect, it } from "vitest";
import {
  companiesQuery,
  dateIdsQuery,
  leadersQuery,
  type RankedSpec,
  schema,
  variantsQuery,
} from "../src/index.ts";
import { queryPlan, testDb } from "../src/testing.ts";

/** A plan step that reads a whole table. Any of these on a public read is the cost the index work removes. */
const scans = (plan: string[]) => plan.filter((step) => /^SCAN\b/.test(step));

const NOW = 2_000_000_000;

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

  it("the companies order is the index order: no full sort of a broad prefix, only of ties", async () => {
    const db = testDb();
    const plan = queryPlan(db, companiesQuery(db, { prefix: "a", limit: 10 }));

    // Before: ORDER BY name needed "USE TEMP B-TREE FOR ORDER BY", a sort of every matched row.
    expect(plan.join("\n")).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
    expect(plan.join("\n")).toContain("USE TEMP B-TREE FOR LAST TERM OF ORDER BY");
  });

  it("companies list case-insensitively, ties by name", async () => {
    const db = testDb();
    await db.insert(schema.companies).values(
      ["banana", "Apple", "apple", "Cherry", "apricot", "Avocado"].map((name, i) => ({
        slug: `s${i}`,
        name,
        updatedAt: 1,
      })),
    );
    const rows = await companiesQuery(db, { prefix: "a", limit: 10 });
    // Byte order would put "Apple", "Avocado" before "apple" and "apricot".
    expect(rows.map((row) => row.name)).toEqual(["Apple", "apple", "apricot", "Avocado"]);
  });
});

const spec: RankedSpec = { titles: ["engineer"] };
const page = { limit: 25, offset: 0 };
const MATCH = '"engineer"';

describe("ranked search candidate cut", () => {
  it("cuts on the FTS index before it looks anything up in jobs", async () => {
    const db = testDb();
    const plan = queryPlan(db, leadersQuery(db, MATCH, spec, page, NOW));
    const text = plan.join("\n");

    // The FTS scan is a subquery of its own (a co-routine or materialization) and `jobs` is searched from its output.
    const fts = plan.findIndex((step) => /SCAN jobs_fts VIRTUAL TABLE/.test(step));
    const lookup = plan.findIndex((step) => /SEARCH jobs USING INTEGER PRIMARY KEY/.test(step));
    expect(fts).toBeGreaterThanOrEqual(0);
    expect(lookup).toBeGreaterThan(fts);
    expect(plan[fts - 1]).toMatch(/CO-ROUTINE|MATERIALIZE/);
    expect(text).not.toMatch(/SCAN jobs\b/);
  });

  it("a selective filter (date window) keeps the filter inside the cut: no window, jobs read per match", async () => {
    const db = testDb();
    const plan = queryPlan(db, leadersQuery(db, MATCH, { ...spec, postedWithin: 30 }, page, NOW));
    const fts = plan.findIndex((step) => /SCAN jobs_fts VIRTUAL TABLE/.test(step));
    const lookup = plan.findIndex((step) => /SEARCH jobs USING INTEGER PRIMARY KEY/.test(step));

    expect(lookup).toBe(fts + 1);
  });

  const seedRows = async (db: ReturnType<typeof testDb>, rows: number) => {
    await db.insert(schema.sources).values({
      id: "greenhouse:acme",
      platform: "greenhouse",
      key: "acme",
      company: "Acme",
      companySlug: "acme",
      params: {},
      lastListedAt: NOW,
    });
    await db.insert(schema.jobs).values(
      Array.from({ length: rows }, (_, i) => ({
        sourceId: "greenhouse:acme",
        postingId: `p${i}`,
        company: "Acme",
        companySlug: "acme",
        // Distinct words in the title lengthen it, so bm25 differs and the closed rows (short titles) rank first.
        title: i < rows / 2 ? "Engineer" : `Engineer ${"filler ".repeat(1 + (i % 5))}${i}`,
        excerpt: "x",
        jdHash: `h${i}`,
        jdBytes: 1,
        sourceHash: "s",
        facts: {},
        sortAt: NOW - i,
        firstSeenAt: 1,
        updatedAt: 1,
        closedAt: i < rows / 2 ? NOW : null,
      })),
    );
  };

  it("matches the filter-inside-the-cut answer whenever the matches fit the window", async () => {
    const db = testDb();
    await seedRows(db, 60);
    const ids = async (s: RankedSpec, window?: number) =>
      (await leadersQuery(db, MATCH, s, { limit: 100, offset: 0 }, NOW, window)).map((r) => r.id);

    // `postedWithin` forces the old path (filter inside the cut); a huge window never binds.
    const inside = await ids({ ...spec, postedWithin: 100_000 });
    expect(inside).toHaveLength(30);
    expect(await ids(spec, 1000)).toEqual(inside);
  });

  it("a window the matches overflow absorbs closed rows only up to its size (the documented difference)", async () => {
    const db = testDb();
    await seedRows(db, 60); // 30 closed rows rank first, 30 open follow
    const ids = async (window: number) =>
      (await leadersQuery(db, MATCH, spec, { limit: 100, offset: 0 }, NOW, window)).map(
        (r) => r.id,
      );

    expect(await ids(60)).toHaveLength(30);
    // With the window at 40 the 10 best open rows fit behind the 30 closed ones; the rest lost the cut.
    expect(await ids(40)).toHaveLength(10);
  });
});

describe("date-sorted search plan", () => {
  it("phase 1 reads ids only: no per-row sibling count, no join of sources", async () => {
    const db = testDb();
    const plan = queryPlan(db, dateIdsQuery(db, MATCH, spec, "recent", page, NOW));
    const text = plan.join("\n");

    expect(text).not.toMatch(/CORRELATED/);
    expect(text).not.toMatch(/SEARCH sources USING (INTEGER PRIMARY KEY|INDEX sqlite_autoindex)/);
    expect(text).toContain("SEARCH jobs USING INTEGER PRIMARY KEY");
  });
});
