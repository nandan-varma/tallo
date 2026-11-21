import { STALE_HIDE_DAYS } from "@tallo/contracts";
import { eq, isNull, type SQL, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  backfillDedupeKeys,
  finalize,
  getJob,
  listVariants,
  rebuildDuplicates,
  schema,
  searchJobs,
  searchSchema,
  startRun,
} from "../src/index.ts";
import { crossedKeys } from "../src/ingest.ts";
import { testDb } from "../src/testing.ts";

const DAY = 86400;
const NOW = 2_000_000_000;
let db: ReturnType<typeof testDb>;
let n = 0;

beforeEach(() => {
  db = testDb();
  n = 0;
});

const FRESH = "fresh";
const STALE = "stale";

async function sources() {
  await db.insert(schema.sources).values([
    {
      id: FRESH,
      platform: "lever",
      key: FRESH,
      company: "Acme",
      companySlug: "acme",
      params: {},
      lastListedAt: NOW,
    },
    {
      id: STALE,
      platform: "lever",
      key: STALE,
      company: "Acme",
      companySlug: "acme",
      params: {},
      lastListedAt: NOW - (STALE_HIDE_DAYS + 1) * DAY,
    },
  ]);
}

/** One open, visible row in the fresh source unless overridden. */
async function row(over: Partial<typeof schema.jobs.$inferInsert> = {}): Promise<number> {
  n++;
  await db.insert(schema.jobs).values({
    sourceId: FRESH,
    postingId: `p${n}`,
    company: "Acme",
    companySlug: "acme",
    title: "Software Engineer",
    locationText: `City ${n}`,
    excerpt: "x",
    jdHash: "a".repeat(64),
    jdBytes: 1,
    sourceHash: "b".repeat(64),
    facts: {},
    sortAt: NOW - n,
    firstSeenAt: NOW,
    updatedAt: NOW,
    countryCode: "US",
    dedupeKey: "k".repeat(64),
    ...over,
  });
  return n;
}

const dupOf = async (id: number) => (await getJob(db, id))?.dupOf ?? undefined;
const visibleIds = async (opts: { includeStale?: boolean } = {}) =>
  (await searchJobs(db, searchSchema.parse({ ...opts, limit: 100 }), NOW)).jobs
    .map((j) => j.id)
    .sort((a, b) => a - b);
const rebuild = (opts: Parameters<typeof rebuildDuplicates>[2] = {}) =>
  rebuildDuplicates(db, NOW, opts);

describe("duplicate groups", () => {
  beforeEach(sources);

  it("keeps the lowest open id as canonical and points the rest at it", async () => {
    const a = await row();
    const b = await row();
    const c = await row();
    const other = await row({ dedupeKey: "o".repeat(64) });
    await rebuild();

    expect(await dupOf(a)).toBeUndefined();
    expect(await dupOf(b)).toBe(a);
    expect(await dupOf(c)).toBe(a);
    expect(await dupOf(other)).toBeUndefined();
    expect(await visibleIds()).toEqual([a, other]);
  });

  it("reports variants on the search result and lists every location on the job page", async () => {
    const a = await row({ locationText: "Austin, TX", applyUrl: "https://x/a" });
    const b = await row({ locationText: "Denver, CO", applyUrl: "https://x/b" });
    await rebuild();

    const [hit] = (await searchJobs(db, searchSchema.parse({}), NOW)).jobs;
    expect(hit?.id).toBe(a);
    expect(hit?.variants).toBe(2);

    const page = await getJob(db, b);
    const variants = await listVariants(db, page!);
    expect(variants.map((v) => [v.id, v.locationText, v.applyUrl])).toEqual([
      [a, "Austin, TX", "https://x/a"],
      [b, "Denver, CO", "https://x/b"],
    ]);
  });

  it("lists only open listings on the job page, the canonical included", async () => {
    const a = await row({ locationText: "Austin, TX" });
    const b = await row({ locationText: "Denver, CO" });
    const c = await row({ locationText: "Boise, ID" });
    await rebuild();
    await db
      .update(schema.jobs)
      .set({ closedAt: NOW, updatedAt: NOW })
      .where(eq(schema.jobs.id, a));

    const variants = await listVariants(db, (await getJob(db, c))!);
    expect(variants.map((v) => v.id)).toEqual([b, c]);
    expect(await listVariants(db, (await getJob(db, b))!)).toHaveLength(2);
  });

  it("hands over to the next open row when the canonical closes", async () => {
    const a = await row();
    const b = await row();
    const c = await row();
    await rebuild();
    await db
      .update(schema.jobs)
      .set({ closedAt: NOW, updatedAt: NOW })
      .where(eq(schema.jobs.id, a));
    await rebuild();

    expect(await dupOf(b)).toBeUndefined();
    expect(await dupOf(c)).toBe(b);
    expect(await visibleIds()).toEqual([b]);
  });

  it("regroups a row that moved to another key and frees the group it left", async () => {
    // Group K = {a, b, c}; a is canonical. Then a's title (and so its key) changes.
    const a = await row({ dedupeKey: "k".repeat(64) });
    const b = await row({ dedupeKey: "k".repeat(64) });
    const c = await row({ dedupeKey: "k".repeat(64) });
    await rebuild();
    // b and c were not touched: only a moved, so K must be found through b's dangling pointer.
    await db
      .update(schema.jobs)
      .set({ updatedAt: NOW - 10 * DAY })
      .where(eq(schema.jobs.dedupeKey, "k".repeat(64)));
    await db
      .update(schema.jobs)
      .set({ dedupeKey: "m".repeat(64), updatedAt: NOW })
      .where(eq(schema.jobs.id, a));
    await rebuild();

    expect(await dupOf(a)).toBeUndefined();
    expect(await dupOf(b)).toBeUndefined();
    expect(await dupOf(c)).toBe(b);
    expect(await visibleIds()).toEqual([a, b]);
  });

  it("shows postings of every country: the database hides nothing by place or kind of work", async () => {
    const abroad = await row({ countryCode: "IN", dedupeKey: "1".repeat(64) });
    const home = await row({ countryCode: "US", dedupeKey: "2".repeat(64), department: "Sales" });
    await rebuild();

    expect(await dupOf(abroad)).toBeUndefined();
    expect(await dupOf(home)).toBeUndefined();
    expect(await visibleIds()).toEqual([abroad, home]);
  });

  it("groups rows that share a key and source freshness, whatever their country", async () => {
    const first = await row({ countryCode: "IN" });
    const second = await row({ countryCode: "US" });
    await rebuild();

    expect(await dupOf(second)).toBe(first);
    expect(await visibleIds()).toEqual([first]);
  });

  it("does not let a stale source's canonical hide a fresh duplicate", async () => {
    const staleRow = await row({ sourceId: STALE });
    const freshRow = await row();
    await rebuild();

    expect(await dupOf(freshRow)).toBeUndefined();
    expect(await visibleIds()).toEqual([freshRow]);
    expect(await visibleIds({ includeStale: true })).toEqual([staleRow, freshRow]);
  });

  it("regroups only the keys touched in the window; a full rebuild fixes the rest", async () => {
    // Both rows look grouped-by-key but were never linked, and nothing about them changed recently.
    const a = await row({ updatedAt: NOW - 10 * DAY });
    const b = await row({ updatedAt: NOW - 10 * DAY });
    await rebuild();
    expect(await dupOf(b)).toBeUndefined();

    await rebuild({ full: true });
    expect(await dupOf(b)).toBe(a);
  });

  it("walks every key across pages in a full rebuild", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await row({ dedupeKey: `${i}`.repeat(64) }));
      ids.push(await row({ dedupeKey: `${i}`.repeat(64) }));
    }
    let after: string | null = "";
    let pages = 0;
    while (after !== null) {
      ({ next: after } = await rebuild({ full: true, after, limit: 2 }));
      pages++;
    }
    // 5 keys at 2 per page: two full pages, then one short page that ends the walk.
    expect(pages).toBe(3);
    expect(await visibleIds()).toEqual(ids.filter((_, i) => i % 2 === 0));
  });

  it("regroups a posting that finalize reopens without a full rebuild", async () => {
    const old = NOW - 10 * DAY;
    const a = await row({ updatedAt: old });
    const b = await row({ updatedAt: old, closedAt: old });
    await rebuild({ full: true });
    expect(await visibleIds()).toEqual([a]);

    await startRun(
      db,
      {
        runId: "run-reopen-01",
        source: { id: FRESH, platform: "lever", key: FRESH, company: "Acme", params: {} },
        runnerId: "test",
        collectorVersion: "1",
        startedAt: NOW - 100,
      },
      NOW - 100,
    );
    await finalize(
      db,
      "run-reopen-01",
      {
        seenIds: [`p${a}`, `p${b}`],
        listingComplete: true,
        detailsComplete: true,
        emptyIsAuthoritative: false,
        requests: 1,
        finishedAt: NOW,
        rawKey: null,
        issues: [],
        boardNotFound: false,
      },
      NOW,
    );
    await rebuild();
    expect(await dupOf(b)).toBe(a);
    expect(await visibleIds()).toEqual([a]);
  });
});

describe("backfill", () => {
  beforeEach(sources);

  it("fills missing keys page by page; grouping waits for a full rebuild", async () => {
    const a = await row({ dedupeKey: null });
    const b = await row({ dedupeKey: null });
    const c = await row({ dedupeKey: null });
    const keyOf = async (r: { title: string }) => `${r.title}`.padEnd(64, "x");

    const first = await backfillDedupeKeys(db, keyOf, { limit: 2 });
    expect(first).toEqual({ updated: 2, more: true, next: b });
    const second = await backfillDedupeKeys(db, keyOf, { after: first.next, limit: 2 });
    expect(second).toEqual({ updated: 1, more: false, next: c });
    expect((await getJob(db, c))?.dedupeKey).toBe("Software Engineer".padEnd(64, "x"));

    await rebuild({ full: true });
    expect(await dupOf(b)).toBe(a);
    expect(await dupOf(c)).toBe(a);
  });

  it("does not rescan keyed rows: pages by id, so each call reads only what it fills", async () => {
    const keyed = await row({ dedupeKey: "k".repeat(64) });
    const unkeyed = await row({ dedupeKey: null });
    const keyOf = async () => "z".repeat(64);
    // The keyed row sits below the cursor, so the next page starts at the unkeyed one.
    expect(await backfillDedupeKeys(db, keyOf, { after: keyed, limit: 1 })).toEqual({
      updated: 1,
      more: false,
      next: unkeyed,
    });
  });

  it("fills a page larger than one batch (120 rows span three batches of 50 statements)", async () => {
    for (let i = 0; i < 120; i++) await row({ dedupeKey: null });
    const page = await backfillDedupeKeys(db, async () => "q".repeat(64), { limit: 120 });
    expect(page).toMatchObject({ updated: 120, more: false });
    const left = await db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(isNull(schema.jobs.dedupeKey));
    expect(left).toEqual([]);
  });
});

/** The planner's detail lines for a query. The proxy returns rows as arrays; detail is the last column. */
async function queryPlan(query: SQL): Promise<string> {
  const rows = await db.all<unknown[]>(sql`EXPLAIN QUERY PLAN ${query}`);
  return rows.map((r) => String(r.at(-1))).join("\n");
}

describe("incremental pass", () => {
  beforeEach(sources);

  it("sees a canonical that finalize closes: its duplicates are visible after the next pass", async () => {
    const old = NOW - 10 * DAY;
    const a = await row({ updatedAt: old, absentRuns: 1 });
    const b = await row({ updatedAt: old });
    await rebuild({ full: true });
    expect(await dupOf(b)).toBe(a);

    // A complete listing without a, on its second absence: finalize closes it.
    await startRun(
      db,
      {
        runId: "run-close-01",
        source: { id: FRESH, platform: "lever", key: FRESH, company: "Acme", params: {} },
        runnerId: "test",
        collectorVersion: "1",
        startedAt: NOW - 100,
      },
      NOW - 100,
    );
    await finalize(
      db,
      "run-close-01",
      {
        seenIds: [`p${b}`],
        listingComplete: true,
        detailsComplete: true,
        emptyIsAuthoritative: false,
        requests: 1,
        finishedAt: NOW,
        rawKey: null,
        issues: [],
        boardNotFound: false,
      },
      NOW,
    );
    expect((await getJob(db, a))?.closedAt).toBe(NOW);

    // No rebuild: the sync's finalize regroups what it wrote, so b is visible at once.
    expect(await dupOf(b)).toBeUndefined();
    expect(await visibleIds()).toEqual([b]);
    await rebuild();
    expect(await visibleIds()).toEqual([b]);
  });

  it("regroups a stale source's keys when its finalize brings it back, with no rebuild and no row write", async () => {
    // STALE is hidden (its last_listed_at is past STALE_HIDE_DAYS), so its canonical a and duplicate c
    // form a group of their own and b (fresh source) is visible alone.
    const old = NOW - 10 * DAY;
    const a = await row({ sourceId: STALE, updatedAt: old });
    const c = await row({ sourceId: STALE, updatedAt: old });
    const b = await row({ updatedAt: old });
    await rebuild({ full: true });
    expect(await dupOf(c)).toBe(a);
    expect(await visibleIds()).toEqual([b]);

    // STALE lists again, with a and c still present. Nothing about the rows changes, so no row is written
    // in the window: the finalize regroup has no key to visit unless the source's own keys are regrouped.
    await startRun(
      db,
      {
        runId: "run-recover-01",
        source: { id: STALE, platform: "lever", key: STALE, company: "Acme", params: {} },
        runnerId: "test",
        collectorVersion: "1",
        startedAt: NOW - 100,
      },
      NOW - 100,
    );
    await finalize(
      db,
      "run-recover-01",
      {
        seenIds: [`p${a}`, `p${c}`],
        listingComplete: true,
        detailsComplete: true,
        emptyIsAuthoritative: false,
        requests: 1,
        finishedAt: NOW,
        rawKey: null,
        issues: [],
        boardNotFound: false,
      },
      NOW,
    );

    // The source is fresh now: one group, canonical a (lowest id). b must be linked without a rebuild.
    expect(await dupOf(b)).toBe(a);
    expect(await dupOf(c)).toBe(a);
    expect(await visibleIds()).toEqual([a]);
  });

  it("regroups a source's keys when it goes stale, with no write to its rows", async () => {
    const CROSSING = "crossing";
    // Crossed the threshold 10 minutes before NOW (inside the window), so it was fresh an hour ago.
    await db.insert(schema.sources).values({
      id: CROSSING,
      platform: "lever",
      key: CROSSING,
      company: "Acme",
      companySlug: "acme",
      params: {},
      lastListedAt: NOW - STALE_HIDE_DAYS * DAY - 600,
    });
    const old = NOW - 10 * DAY;
    const a = await row({ updatedAt: old });
    const b = await row({ updatedAt: old, sourceId: CROSSING });
    await rebuildDuplicates(db, NOW - 3600, { full: true });
    expect(await dupOf(b)).toBe(a);

    // Nothing was written in the window, so only the crossed source's keys can be regrouped.
    await rebuild();
    expect(await dupOf(b)).toBeUndefined();
    expect(await visibleIds({ includeStale: true })).toEqual([a, b]);
  });

  it("uses the updated_at index for the window and the dedupe index for the regroup", async () => {
    // Guards the hourly pass: a scan of jobs here reads every open row each hour.
    const details = await queryPlan(
      sql`SELECT DISTINCT dedupe_key FROM jobs WHERE dedupe_key IS NOT NULL AND updated_at >= ${NOW}`,
    );
    expect(details).toContain("jobs_updated_idx");
    expect(details).not.toMatch(/SCAN jobs(?! USING)/);
  });

  it("finds crossed sources' keys through jobs_source_posting_idx, not a scan of jobs", async () => {
    // Plans the function the hourly pass runs. A join from jobs to sources scanned every open keyed row.
    const details = await queryPlan(
      crossedKeys(db, NOW - 3 * 3600, NOW - STALE_HIDE_DAYS * DAY).getSQL(),
    );
    expect(details).toContain("jobs_source_posting_idx");
    expect(details).not.toContain("jobs_dedupe_idx");
    expect(details).not.toMatch(/SCAN jobs(?! USING)/);
  });

  it("finds a changed canonical's duplicates through dup_of without scanning jobs", async () => {
    const details = await queryPlan(
      sql`SELECT DISTINCT dedupe_key FROM jobs WHERE dup_of IS NOT NULL AND closed_at IS NULL AND dedupe_key IS NOT NULL AND dup_of IN (SELECT canonicals.id FROM jobs AS canonicals WHERE canonicals.updated_at >= ${NOW})`,
    );
    expect(details).toContain("jobs_updated_idx");
    expect(details).toContain("jobs_dup_of_idx");
    expect(details).not.toMatch(/SCAN/);
  });

  it("backfill reads by primary key, not a scan", async () => {
    const details = await queryPlan(
      sql`SELECT id FROM jobs WHERE id > ${0} AND dedupe_key IS NULL ORDER BY id LIMIT 301`,
    );
    expect(details).not.toMatch(/SCAN jobs(?! USING)/);
  });
});
