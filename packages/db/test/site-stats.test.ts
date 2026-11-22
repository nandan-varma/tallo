import { describe, expect, it } from "vitest";
import { readSiteStats, refreshSiteStats, schema } from "../src/index.ts";
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

describe("refreshSiteStats", () => {
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

    const stats = await refreshSiteStats(db, NOW);
    expect(await readSiteStats(db)).toEqual(stats);

    expect(stats.asOf).toBe(NOW);
    expect(stats.boards).toBe(4);
    expect(stats.platforms).toBe(3);
    expect(stats.employers).toBe(2);
    // Counted, not estimated: job 1, 2 (fresh board a) and 3 (b); closed and duplicate rows are left out.
    expect(stats.openJobs).toBe(3);
    expect(stats.collectedTotal).toBe(5);
    expect(stats.health).toEqual({ failing: 0, dead: 0 });
    expect(stats.freshness).toMatchObject({ listed7d: 1, listed14d: 2, newestRunAt: NOW - 3600 });
    expect(stats.freshness.added24h).toBe(2);
    expect(stats.freshness.added7d).toBe(4);
    expect(stats.freshness.closed7d).toBe(6);
    expect(stats.byPlatform[0]).toEqual({ platform: "greenhouse", boards: 1, open: 2 });
    expect(stats.topEmployers.map((e) => e.name)).toEqual(["Acme", "Beta"]);
    expect(stats.history).toEqual([{ day: NOW - (NOW % DAY), openJobs: 3, added: 2 }]);
    expect(stats.countries.distinct).toBe(2);
    expect(stats.countries.top[0]?.code).toBe("US");
    expect(stats.mix.remote).toBeCloseTo(1 / 3);
    expect(stats.mix.unstated).toBeCloseTo(1 / 3);
    expect(stats.mix.payStated).toBeCloseTo(1 / 3);
    expect(stats.mix.postedStated).toBeCloseTo(1 / 3);
  });

  it("answers on an empty database", async () => {
    const stats = await refreshSiteStats(testDb(), NOW);
    expect(stats).toMatchObject({
      openJobs: 0,
      boards: 0,
      collectedTotal: 0,
      mix: { payStated: 0 },
    });
    expect(stats.freshness.newestRunAt).toBeNull();
  });

  it("recounts the catalog about daily and keeps one history point per day", async () => {
    const db = testDb();
    await db.insert(schema.sources).values(source("a", "greenhouse", "Acme", 1));
    await db.insert(schema.jobs).values(job(1, "greenhouse:a"));
    await refreshSiteStats(db, NOW);

    await db.insert(schema.jobs).values(job(2, "greenhouse:a"));
    const hourLater = await refreshSiteStats(db, NOW + 3600);
    expect(hourLater.openJobs).toBe(1);
    expect(hourLater.asOf).toBe(NOW + 3600);
    expect(hourLater.catalogAsOf).toBe(NOW);

    const nextDay = await refreshSiteStats(db, NOW + DAY);
    expect(nextDay.openJobs).toBe(2);
    expect(nextDay.history.map((p) => p.openJobs)).toEqual([1, 2]);
  });

  it("counts failing and retired boards", async () => {
    const db = testDb();
    await db.insert(schema.sources).values([
      { ...source("a", "greenhouse", "Acme", 1), failureCount: 2 },
      { ...source("b", "lever", "Beta", 1), status: "dead" as const },
    ]);
    const stats = await refreshSiteStats(db, NOW);
    expect(stats.health).toEqual({ failing: 1, dead: 1 });
    expect(stats.boards).toBe(1);
  });

  it("reads the catalog once a day and a page view reads one row", async () => {
    const db = testDb();
    await refreshSiteStats(db, NOW);
    const afterRefresh = readCost(db).queries;
    expect(afterRefresh).toBeLessThanOrEqual(8);
    await readSiteStats(db);
    expect(readCost(db).queries).toBe(afterRefresh + 1);
  });
});
