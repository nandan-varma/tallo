import { STALE_HIDE_DAYS } from "@tallo/contracts";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  backfillDedupeKeys,
  finalize,
  getJob,
  listVariants,
  rebuildDuplicates,
  rebuildFacets,
  reclassify,
  schema,
  searchJobs,
  searchSchema,
  startRun,
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

/** One open, visible, US tech row in the fresh source unless overridden. */
async function row(over: Partial<typeof schema.jobs.$inferInsert> = {}): Promise<number> {
  n++;
  await db.insert(schema.jobs).values({
    sourceId: FRESH,
    postingId: `p${n}`,
    company: "Acme",
    companySlug: "acme",
    title: "Software Engineer",
    locationText: `City ${n}`,
    classifierVersion: 1,
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
const visibleIds = async (opts: { all?: boolean; includeStale?: boolean } = {}) =>
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

  it("does not hide a visible row behind a hidden canonical", async () => {
    const hidden = await row({ hidden: 1, countryCode: "IN" });
    const visible = await row({ countryCode: "US" });
    await rebuild();

    expect(await dupOf(visible)).toBeUndefined();
    expect(await dupOf(hidden)).toBeUndefined();
    expect(await visibleIds()).toEqual([visible]);
    expect(await visibleIds({ all: true })).toEqual([hidden, visible]);
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

  it("regroups a row that reclassify hid or reopened, without a full rebuild", async () => {
    const old = NOW - 10 * DAY;
    const a = await row({ updatedAt: old });
    const b = await row({ updatedAt: old, department: "Sales" });
    await rebuild({ full: true });
    expect(await dupOf(b)).toBe(a);

    // Reclassify hides b (out of scope) and must make the incremental pass see it.
    await reclassify(
      db,
      (r) => ({ isUs: r.department === "Sales" ? 0 : 1, isTech: 1, version: 2 }),
      2,
      300,
      NOW,
    );
    await rebuild();
    expect(await dupOf(b)).toBeUndefined();
    expect(await visibleIds({ all: true })).toEqual([a, b]);
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

  it("keeps duplicates out of facet counts", async () => {
    await row({ department: "Engineering" });
    await row({ department: "Engineering" });
    await rebuild();
    await rebuildFacets(db, NOW);

    const counts = await db.select().from(schema.facetCounts);
    expect(counts.find((c) => c.facet === "department")?.count).toBe(1);
  });
});

describe("backfill", () => {
  beforeEach(sources);

  it("fills missing keys page by page; grouping waits for a full rebuild", async () => {
    const a = await row({ dedupeKey: null });
    const b = await row({ dedupeKey: null });
    const c = await row({ dedupeKey: null });
    const keyOf = async (r: { title: string }) => `${r.title}`.padEnd(64, "x");

    expect(await backfillDedupeKeys(db, keyOf, 2)).toEqual({ updated: 2, more: true });
    expect(await backfillDedupeKeys(db, keyOf, 2)).toEqual({ updated: 1, more: false });
    expect((await getJob(db, c))?.dedupeKey).toBe("Software Engineer".padEnd(64, "x"));

    await rebuild({ full: true });
    expect(await dupOf(b)).toBe(a);
    expect(await dupOf(c)).toBe(a);
  });
});
