import { beforeEach, describe, expect, it } from "vitest";
import {
  FACET_LIMIT,
  listFacets,
  rebuildFacets,
  schema,
  searchJobs,
  searchSchema,
} from "../src/index.ts";
import { testDb } from "../src/testing.ts";

const DAY = 86400;
const NOW = 2_000_000_000;
let db: ReturnType<typeof testDb>;
let n = 0;

beforeEach(() => {
  db = testDb();
  n = 0;
});

async function source(id: string, lastListedAt: number | null) {
  await db.insert(schema.sources).values({
    id,
    platform: "greenhouse",
    key: id,
    company: id,
    companySlug: id,
    params: {},
    lastListedAt,
  });
}

/** A visible, open, US tech job unless overridden. */
async function job(over: Partial<typeof schema.jobs.$inferInsert> = {}) {
  n++;
  await db.insert(schema.jobs).values({
    sourceId: "fresh",
    postingId: `p${n}`,
    company: "Fresh Co",
    companySlug: "fresh",
    title: `Engineer ${n}`,
    classifierVersion: 1,
    excerpt: "x",
    jdHash: "a".repeat(64),
    jdBytes: 1,
    sourceHash: "b".repeat(64),
    facts: {},
    sortAt: NOW - n,
    firstSeenAt: NOW,
    updatedAt: NOW,
    department: "Engineering",
    employmentType: "full_time",
    workMode: "remote",
    countryCode: "US",
    ...over,
  });
}

const values = (list: { value: string; count: number }[]) => list.map((v) => [v.value, v.count]);

describe("facets", () => {
  it("returns empty facets before the first rebuild", async () => {
    expect(await listFacets(db)).toEqual({
      computedAt: null,
      workMode: [],
      department: [],
      employmentType: [],
      country: [],
    });
  });

  it("counts only the jobs a default search would show", async () => {
    await source("fresh", NOW);
    await source("stale", NOW - 30 * DAY);
    await job({ sourceId: "fresh" });
    await job({ sourceId: "fresh", hidden: 1, department: "Hidden Dept" });
    await job({ sourceId: "fresh", closedAt: NOW - 1, department: "Closed Dept" });
    await job({ sourceId: "stale", sourceHash: "c".repeat(64), department: "Stale Dept" });
    await job({
      sourceId: "fresh",
      department: null,
      employmentType: null,
      workMode: null,
      countryCode: null,
    });

    expect(await rebuildFacets(db, NOW)).toEqual({ values: 4 });
    const facets = await listFacets(db);
    expect(facets.computedAt).toBe(NOW);
    expect(values(facets.department)).toEqual([["Engineering", 1]]);
    expect(values(facets.employmentType)).toEqual([["full_time", 1]]);
    expect(values(facets.workMode)).toEqual([["remote", 1]]);
    expect(values(facets.country)).toEqual([["US", 1]]);
  });

  it("agrees with the search filter for every facet value", async () => {
    await source("fresh", NOW);
    await source("stale", NOW - 30 * DAY);
    await job({ department: "Engineering", countryCode: "US", workMode: "remote" });
    await job({
      department: "Engineering",
      countryCode: "CA",
      workMode: "hybrid",
      employmentType: "contract",
    });
    await job({ department: "Data", countryCode: "US", workMode: "remote" });
    await job({ department: "Data", countryCode: "US", hidden: 1 });
    await job({ sourceId: "stale", department: "Engineering", countryCode: "US" });
    await rebuildFacets(db, NOW);

    const facets = await listFacets(db);
    const filters = [
      ...facets.department.map((v) => ({ key: "department", ...v })),
      ...facets.employmentType.map((v) => ({ key: "employmentType", ...v })),
      ...facets.workMode.map((v) => ({ key: "workMode", ...v })),
      ...facets.country.map((v) => ({ key: "country", ...v })),
    ];
    expect(filters.length).toBeGreaterThan(0);
    for (const { key, value, count } of filters) {
      const page = await searchJobs(db, searchSchema.parse({ [key]: value, limit: 100 }), NOW);
      expect(page.jobs, `${key}=${value}`).toHaveLength(count);
    }
  });

  it("replaces the whole snapshot on each rebuild", async () => {
    await source("fresh", NOW);
    await job({ department: "Old Dept" });
    await rebuildFacets(db, NOW);
    expect(values((await listFacets(db)).department)).toEqual([["Old Dept", 1]]);

    await db.update(schema.jobs).set({ department: "New Dept" });
    await rebuildFacets(db, NOW + 60);
    const facets = await listFacets(db);
    expect(values(facets.department)).toEqual([["New Dept", 1]]);
    expect(facets.computedAt).toBe(NOW + 60);
  });

  it("keeps the most common values per facet, most common first", async () => {
    await source("fresh", NOW);
    for (const [department, copies] of [
      ["Rare", 1],
      ["Common", 3],
      ["Middling", 2],
    ] as const) {
      for (let i = 0; i < copies; i++) await job({ department });
    }
    await rebuildFacets(db, NOW, 2);
    expect(values((await listFacets(db)).department)).toEqual([
      ["Common", 3],
      ["Middling", 2],
    ]);
  });

  it("caps values at FACET_LIMIT by default", async () => {
    await source("fresh", NOW);
    for (let i = 0; i < FACET_LIMIT + 5; i++) await job({ department: `Dept ${i}` });
    await rebuildFacets(db, NOW);
    expect((await listFacets(db)).department).toHaveLength(FACET_LIMIT);
  });
});
