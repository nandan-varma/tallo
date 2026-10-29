import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { rebuildDuplicates, schema } from "../src/index.ts";
import { testDb } from "../src/testing.ts";

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
async function row(key: string, updatedAt: number, dupOf: number | null = null): Promise<number> {
  n++;
  const [inserted] = await db
    .insert(schema.jobs)
    .values({
      sourceId: SOURCE,
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

  it("does not move the cursor on a full rebuild that stopped early", async () => {
    await row("K-a", NOW - HOUR);
    await row("K-b", NOW - HOUR);
    const page = await rebuildDuplicates(db, NOW, { full: true, limit: 1 });
    expect(page.next).not.toBeNull();
    expect(await cursor()).toBeUndefined();
  });
});
