import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { rebuildDuplicates, schema } from "../src/index.ts";
import { readCost, testDb } from "../src/testing.ts";

const HOUR = 3600;
const NOW = 2_000_000_000;
const SOURCE = "fresh";
let db: ReturnType<typeof testDb>;
let n = 0;

beforeEach(async () => {
  db = testDb();
  n = 0;
  await db.insert(schema.sources).values({
    id: SOURCE,
    platform: "lever",
    key: SOURCE,
    company: "Acme",
    companySlug: "acme",
    params: {},
    lastListedAt: NOW,
  });
});

/** An open row in the fresh source with the given group key; `dupOf` is set by the test, not derived. */
async function row(
  key: string,
  updatedAt: number,
  dupOf: number | null = null,
  sourceId = SOURCE,
): Promise<number> {
  n++;
  const [inserted] = await db
    .insert(schema.jobs)
    .values({
      sourceId,
      postingId: `p${n}`,
      company: "Acme",
      companySlug: "acme",
      title: `Engineer ${n}`,
      jdHash: `h${n}`,
      jdBytes: 1,
      sourceHash: `s${n}`,
      excerpt: "",
      facts: {},
      sortAt: NOW,
      firstSeenAt: NOW,
      updatedAt,
      dedupeKey: key,
      dupOf,
    })
    .returning({ id: schema.jobs.id });
  return inserted?.id ?? 0;
}

const dupOf = async (id: number) =>
  (await db.select({ dupOf: schema.jobs.dupOf }).from(schema.jobs).where(eq(schema.jobs.id, id)))[0]
    ?.dupOf;

const cursor = async () =>
  (await db.select().from(schema.regroupState).where(eq(schema.regroupState.id, 1)))[0]?.checkedAt;

describe("regroup cursor", () => {
  it("starts an incremental pass at the cursor less the margin, and records the pass", async () => {
    // Pairs stored with dup_of unset are wrong on purpose: only a pass whose window reaches them repairs them.
    await db.insert(schema.regroupState).values({ id: 1, checkedAt: NOW });
    await row("K-out", NOW - HOUR); // before NOW - 30 minutes: outside the next window
    const outsideDup = await row("K-out", NOW - HOUR);
    const inside = await row("K-in", NOW - 10 * 60); // inside the margin
    const insideDup = await row("K-in", NOW - 10 * 60);

    await rebuildDuplicates(db, NOW + HOUR);
    expect(await dupOf(insideDup)).toBe(inside);
    expect(await dupOf(outsideDup)).toBeNull();
    expect(await cursor()).toBe(NOW + HOUR);
  });

  it("looks back three hours when no pass has run yet", async () => {
    const canonical = await row("K-first", NOW - 2 * HOUR);
    const dup = await row("K-first", NOW - 2 * HOUR);
    await rebuildDuplicates(db, NOW);
    expect(await dupOf(dup)).toBe(canonical);
    expect(await cursor()).toBe(NOW);
  });

  it("leaves the cursor alone until the last page, so an interrupted pass is retried in full", async () => {
    await row("K-a", NOW - HOUR);
    await row("K-b", NOW - HOUR);
    await row("K-c", NOW - HOUR);

    const first = await rebuildDuplicates(db, NOW, { limit: 1 });
    expect(first.next).not.toBeNull();
    expect(await cursor()).toBeUndefined();

    let page = first;
    while (page.next !== null)
      page = await rebuildDuplicates(db, NOW, { limit: 1, after: page.next });
    expect(await cursor()).toBe(NOW);
  });

  it("does not materialize the entire change window again for each small page", async () => {
    for (let i = 0; i < 20; i++) await row(`K-${i.toString().padStart(2, "0")}`, NOW - HOUR);
    const before = readCost(db);
    let page = await rebuildDuplicates(db, NOW, { limit: 2 });
    while (page.next !== null)
      page = await rebuildDuplicates(db, NOW, { limit: 2, after: page.next });
    const after = readCost(db);
    expect(after.rows - before.rows).toBeLessThan(100);
    expect(await cursor()).toBe(NOW);
  });

  it("does not move the cursor on a full rebuild that stopped early", async () => {
    await row("K-a", NOW - HOUR);
    await row("K-b", NOW - HOUR);
    const page = await rebuildDuplicates(db, NOW, { full: true, limit: 1 });
    expect(page.next).not.toBeNull();
    expect(await cursor()).toBeUndefined();
  });

  it("stays linear when the backlog grows and pages stay small", async () => {
    const keys = 60;
    for (let i = 0; i < keys; i++) await row(`K-${i.toString().padStart(2, "0")}`, NOW - HOUR);
    const before = readCost(db);
    let page = await rebuildDuplicates(db, NOW, { limit: 2 });
    while (page.next !== null)
      page = await rebuildDuplicates(db, NOW, { limit: 2, after: page.next });
    const after = readCost(db);
    // Candidate rows and the rows regroup reads, not every key again on every page.
    expect(after.rows - before.rows).toBeLessThan(4 * keys);
    expect(await cursor()).toBe(NOW);
  });

  it("keeps the original pass boundary when it resumes at a later wall time", async () => {
    for (let i = 0; i < 3; i++) await row(`K-${i}`, NOW - HOUR);
    const first = await rebuildDuplicates(db, NOW, { limit: 1 });
    expect(first.next).not.toBeNull();
    expect(await cursor()).toBeUndefined();

    let page = await rebuildDuplicates(db, NOW + 1000, { limit: 1, after: first.next! });
    while (page.next !== null) {
      expect(await cursor()).toBeUndefined();
      page = await rebuildDuplicates(db, NOW + 1000, { limit: 1, after: page.next });
    }
    // The resumed pass records when it started, not when its last page ran.
    expect(await cursor()).toBe(NOW);
  });

  it("leaves a concurrent write behind the cursor for the next pass", async () => {
    await db.insert(schema.regroupState).values({ id: 1, checkedAt: NOW });
    const canonical = await row("K-a", NOW - 1000);
    const duplicate = await row("K-a", NOW - 1000);
    await row("K-b", NOW - 1000); // one more page, so the pass does not finish here

    const first = await rebuildDuplicates(db, NOW, { limit: 2 });
    expect(await dupOf(duplicate)).toBe(canonical);
    expect(first.next).not.toBeNull();

    // A write behind the resumed cursor: same updated_at, lower id than the cursor. It stays broken
    // for this pass, and the next pass's window must still reach it.
    await db.update(schema.jobs).set({ dupOf: null }).where(eq(schema.jobs.id, duplicate));

    let page = await rebuildDuplicates(db, NOW + 1000, { limit: 2, after: first.next! });
    while (page.next !== null)
      page = await rebuildDuplicates(db, NOW + 1000, { limit: 2, after: page.next });
    expect(await cursor()).toBe(NOW);
    expect(await dupOf(duplicate)).toBeNull();

    await rebuildDuplicates(db, NOW + 1000);
    expect(await dupOf(duplicate)).toBe(canonical);
    expect(await cursor()).toBe(NOW + 1000);
  });

  it("leaves a full key rebuild's checkpoint alone and the next pass repairs a skipped write", async () => {
    await db.insert(schema.regroupState).values({ id: 1, checkedAt: NOW });
    await row("A-key", NOW - HOUR);
    await row("B-key", NOW - HOUR);
    const first = await rebuildDuplicates(db, NOW, { full: true, limit: 1 });
    expect(first.next).not.toBeNull();

    // Written after the full pass read past its key: the key cursor cannot reach it.
    const canonical = await row("0-key", NOW - 100);
    const duplicate = await row("0-key", NOW - 100);
    let page = first;
    while (page.next !== null)
      page = await rebuildDuplicates(db, NOW, { full: true, limit: 1, after: page.next });

    expect(await cursor()).toBe(NOW);
    expect(await dupOf(duplicate)).toBeNull();

    // The incremental checkpoint still points before the write, so the next pass repairs it.
    await rebuildDuplicates(db, NOW + 1000);
    expect(await dupOf(duplicate)).toBe(canonical);
  });

  it("repairs a moved canonical's duplicates across tiny pages", async () => {
    const a = await row("K-old", NOW - HOUR);
    const b = await row("K-old", NOW - HOUR);
    const c = await row("K-old", NOW - HOUR);
    await rebuildDuplicates(db, NOW, { full: true });
    expect(await dupOf(b)).toBe(a);
    expect(await dupOf(c)).toBe(a);

    // The canonical moves to a new key. Only its old duplicates' keys can repair the group.
    await db
      .update(schema.jobs)
      .set({ dedupeKey: "K-new", updatedAt: NOW - 10 })
      .where(eq(schema.jobs.id, a));

    let page = await rebuildDuplicates(db, NOW, { limit: 1 });
    while (page.next !== null)
      page = await rebuildDuplicates(db, NOW, { limit: 1, after: page.next });

    expect(await dupOf(a)).toBeNull();
    expect(await dupOf(b)).toBeNull();
    expect(await dupOf(c)).toBe(b);
    expect(await cursor()).toBe(NOW);
  });

  it("repairs the old group when the canonical's key becomes null", async () => {
    const a = await row("K-null", NOW - HOUR);
    const b = await row("K-null", NOW - HOUR);
    const c = await row("K-null", NOW - HOUR);
    await rebuildDuplicates(db, NOW, { full: true });
    expect(await dupOf(b)).toBe(a);
    expect(await dupOf(c)).toBe(a);

    await db
      .update(schema.jobs)
      .set({ dedupeKey: null, updatedAt: NOW - 10 })
      .where(eq(schema.jobs.id, a));

    let page = await rebuildDuplicates(db, NOW, { limit: 1 });
    while (page.next !== null)
      page = await rebuildDuplicates(db, NOW, { limit: 1, after: page.next });

    expect(await dupOf(a)).toBeNull();
    expect(await dupOf(b)).toBeNull();
    expect(await dupOf(c)).toBe(b);
  });

  it("regroups crossed sources' keys one page at a time", async () => {
    const cross = (id: string) => ({
      id,
      platform: "lever",
      key: id,
      company: "Acme",
      companySlug: "acme",
      params: {},
      lastListedAt: NOW,
    });
    await db.insert(schema.sources).values([cross("cross-a"), cross("cross-b")]);
    const old = NOW - 10 * 24 * HOUR;
    const a1 = await row("K-1", old);
    const b1 = await row("K-1", old, null, "cross-a");
    const a2 = await row("K-2", old);
    const b2 = await row("K-2", old, null, "cross-b");
    await rebuildDuplicates(db, NOW, { full: true });
    expect(await dupOf(b1)).toBe(a1);
    expect(await dupOf(b2)).toBe(a2);

    // The crossing is a time change with no row write, so only the stale phase can find it.
    await db
      .update(schema.sources)
      .set({ lastListedAt: NOW - 14 * 24 * HOUR - 600 })
      .where(eq(schema.sources.id, "cross-a"));
    await db
      .update(schema.sources)
      .set({ lastListedAt: NOW - 14 * 24 * HOUR - 600 })
      .where(eq(schema.sources.id, "cross-b"));
    await db.insert(schema.regroupState).values({ id: 1, checkedAt: NOW });

    let page = await rebuildDuplicates(db, NOW, { limit: 1 });
    let pages = 1;
    while (page.next !== null) {
      page = await rebuildDuplicates(db, NOW, { limit: 1, after: page.next });
      pages++;
    }

    expect(pages).toBeGreaterThan(1);
    expect(await dupOf(b1)).toBeNull();
    expect(await dupOf(b2)).toBeNull();
    expect(await cursor()).toBe(NOW);
  });

  const token = (over: Record<string, unknown> = {}) =>
    `i1:${JSON.stringify({
      at: NOW,
      since: NOW - 1800,
      phase: "updated",
      updatedAt: NOW - 1800,
      id: 0,
      duplicateId: 0,
      source: "",
      posting: "",
      ...over,
    })}`;

  it.each([
    ["a legacy plain key", "K-old", 409],
    ["empty JSON", "i1:", 409],
    ["a missing field", "i1:{}", 409],
    ["a future pass", token({ at: NOW + 1 }), 409],
    ["a time outside the pass", token({ updatedAt: NOW + 1 }), 409],
    ["an unknown phase", token({ phase: "later" }), 409],
    ["an extra field", token({ extra: true }), 409],
    ["an oversized token", `i1:${"x".repeat(8192)}`, 409],
    ["an oversized source", token({ source: "s".repeat(201) }), 409],
  ])("rejects %s with an explicit conflict", async (_name, after, status) => {
    await expect(rebuildDuplicates(db, NOW, { after })).rejects.toMatchObject({ status });
  });

  it("rejects an incremental token on a full rebuild but still continues from a plain key", async () => {
    await expect(rebuildDuplicates(db, NOW, { full: true, after: token() })).rejects.toMatchObject({
      status: 409,
    });
    await expect(rebuildDuplicates(db, NOW, { full: true, after: "K-old" })).resolves.toEqual({
      keys: 0,
      changed: 0,
      next: null,
    });
  });
});
