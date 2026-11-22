import { describe, expect, it } from "vitest";
import { schema, siteStats } from "../src/index.ts";
import { readCost, testDb } from "../src/testing.ts";

const NOW = 2_000_000_000;
const DAY = 86400;

const source = (key: string, platform: string, company: string, listedDaysAgo: number | null) => ({
  id: `${platform}:${key}`,
  platform,
  key,
  company,
  companySlug: company.toLowerCase(),
  params: {},
  lastRunAt: NOW - 3600,
  lastListedAt: listedDaysAgo === null ? null : NOW - listedDaysAgo * DAY,
});

const run = (id: string, sourceId: string, ago: number, over: object = {}) => ({
  id,
  sourceId,
  runnerId: "r",
  collectorVersion: "1",
  startedAt: NOW - ago,
  status: "complete" as const,
  seen: 10,
  added: 2,
  closed: 1,
  ...over,
});

const job = (n: number, sourceId: string, over: Partial<typeof schema.jobs.$inferInsert> = {}) => ({
  sourceId,
  postingId: `p${n}`,
  company: "Acme",
  companySlug: "acme",
  title: "Engineer",
  excerpt: "",
  jdHash: "h",
  jdBytes: 1,
  sourceHash: "s",
  facts: {},
  sortAt: NOW,
  firstSeenAt: NOW,
  updatedAt: NOW,
  ...over,
});

describe("siteStats", () => {
  it("counts boards, freshness and the sample from a few seeded rows", async () => {
    const db = testDb();
    await db
      .insert(schema.sources)
      .values([
        source("a", "greenhouse", "Acme", 1),
        source("b", "lever", "Beta", 10),
        source("c", "lever", "Gone", 40),
        source("d", "ashby", "Never", null),
      ]);
    await db
      .insert(schema.runs)
      .values([
        run("r1", "greenhouse:a", 3600),
        run("r2", "greenhouse:a", 5 * DAY, { seen: 99 }),
        run("r3", "lever:b", 2 * DAY, { seen: 5, added: 0, closed: 4 }),
        run("r4", "lever:c", 30 * DAY, { seen: 7 }),
      ]);
    await db.insert(schema.jobs).values([
      job(1, "greenhouse:a", {
        countryCode: "US",
        workMode: "remote",
        postedAt: 1,
        facts: { compensation: [{ min: 1 }] },
      }),
      job(2, "greenhouse:a", { countryCode: "US", workMode: "onsite" }),
      job(3, "lever:b", { countryCode: "DE" }),
      job(4, "lever:b", { closedAt: NOW }),
      job(5, "lever:b", { dupOf: 3 }),
    ]);

    const stats = await siteStats(db, NOW);

    expect(stats.asOf).toBe(NOW);
    expect(stats.boards).toBe(4);
    expect(stats.platforms).toBe(3);
    expect(stats.employers).toBe(2);
    // The last complete listing of each fresh board: 10 (not the older 99) plus 5.
    expect(stats.openJobs).toBe(15);
    expect(stats.freshness).toMatchObject({ listed7d: 1, listed14d: 2, newestRunAt: NOW - 3600 });
    expect(stats.freshness.added24h).toBe(2);
    expect(stats.freshness.added7d).toBe(4);
    expect(stats.freshness.closed7d).toBe(6);
    expect(stats.byPlatform[0]).toEqual({ platform: "greenhouse", boards: 1, open: 10 });
    expect(stats.topEmployers.map((e) => e.name)).toEqual(["Acme", "Beta"]);
    expect(stats.sampleSize).toBe(3);
    expect(stats.countries.distinct).toBe(2);
    expect(stats.countries.top[0]?.code).toBe("US");
    expect(stats.mix.remote).toBeCloseTo(1 / 3);
    expect(stats.mix.unstated).toBeCloseTo(1 / 3);
    expect(stats.mix.payStated).toBeCloseTo(1 / 3);
    expect(stats.mix.postedStated).toBeCloseTo(1 / 3);
  });

  it("answers on an empty database", async () => {
    const stats = await siteStats(testDb(), NOW);
    expect(stats).toMatchObject({ openJobs: 0, boards: 0, sampleSize: 0, mix: { payStated: 0 } });
    expect(stats.freshness.newestRunAt).toBeNull();
  });

  it("reads bounded rows: sources, runs and at most the sample windows", async () => {
    const db = testDb();
    await siteStats(db, NOW);
    expect(readCost(db).queries).toBeLessThanOrEqual(9);
  });
});
