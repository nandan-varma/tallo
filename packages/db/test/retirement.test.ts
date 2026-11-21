import { RETIRE_MAX_ROWS } from "@tallo/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  jdKey,
  memoryBlobs,
  rawKey,
  rebuildDuplicates,
  retireSources,
  schema,
} from "../src/index.ts";
import { getJob, searchJobs, testDb } from "../src/testing.ts";

const NOW = 2_000_000_000;
const OLD = "greenhouse:old";
const KEEP = "greenhouse:keep";
const h = (c: string) => c.repeat(64);
const SHARED = h("a");
const UNIQUE = h("b");
const KEPT = h("c");
const KEY_GROUP = h("1");
const KEY_SHARED_OLD = h("2");
const KEY_SHARED_KEEP = h("3");
const KEY_UNIQUE_OLD = h("4");

let db: ReturnType<typeof testDb>;
let blobs: ReturnType<typeof memoryBlobs>;
let n = 0;

beforeEach(() => {
  db = testDb();
  blobs = memoryBlobs();
  n = 0;
});

async function seedSources() {
  await db.insert(schema.sources).values([
    {
      id: OLD,
      platform: "greenhouse",
      key: "old",
      company: "Old Co",
      companySlug: "old-co",
      params: {},
      lastListedAt: NOW,
    },
    {
      id: KEEP,
      platform: "greenhouse",
      key: "keep",
      company: "Keep Co",
      companySlug: "keep-co",
      params: {},
      lastListedAt: NOW,
    },
  ]);
}

/** One open row; the caller names its dedupe group and description. */
async function row(
  sourceId: string,
  over: Partial<typeof schema.jobs.$inferInsert> = {},
): Promise<number> {
  n++;
  const [inserted] = await db
    .insert(schema.jobs)
    .values({
      sourceId,
      postingId: `p${n}`,
      company: "Company",
      companySlug: "company",
      title: `Job ${n}`,
      excerpt: "x",
      jdHash: KEPT,
      jdBytes: 1,
      sourceHash: h("d"),
      facts: {},
      sortAt: NOW - n,
      firstSeenAt: NOW - 1000,
      updatedAt: NOW - 1000,
      ...over,
    })
    .returning({ id: schema.jobs.id });
  return inserted!.id;
}

async function addRun(
  id: string,
  sourceId: string,
  startedAt: number,
  rawKey: string | null,
  status: "running" | "complete" = "complete",
) {
  await db.insert(schema.runs).values({
    id,
    sourceId,
    runnerId: "mac",
    collectorVersion: "t",
    startedAt,
    status,
    rawKey,
  });
}

/**
 * The old board owns the canonical of a three-row group and two descriptions, one shared with the
 * surviving board. The foreign raw key is not source-owned and must not be offered for cleanup.
 */
async function scenario() {
  await seedSources();
  const canonical = await row(OLD, { dedupeKey: KEY_GROUP, jdHash: UNIQUE });
  const first = await row(KEEP, { dedupeKey: KEY_GROUP, jdHash: h("e") });
  const second = await row(KEEP, { dedupeKey: KEY_GROUP, jdHash: h("f") });
  const sharedOld = await row(OLD, { dedupeKey: KEY_SHARED_OLD, jdHash: SHARED });
  const sharedKeep = await row(KEEP, { dedupeKey: KEY_SHARED_KEEP, jdHash: SHARED });
  const uniqueOld = await row(OLD, { dedupeKey: KEY_UNIQUE_OLD, jdHash: UNIQUE });
  await rebuildDuplicates(db, NOW, { full: true });
  expect((await getJob(db, first))?.dupOf).toBe(canonical);
  expect((await getJob(db, second))?.dupOf).toBe(canonical);

  const ownPack = rawKey(OLD, "run-own");
  await addRun("run-own", OLD, NOW - 300, ownPack);
  await addRun("run-foreign", OLD, NOW - 200, "raw/somewhere/else.ndjson.gz");
  await addRun("run-bare", OLD, NOW - 100, null);
  for (const hash of [SHARED, UNIQUE, h("e"), h("f")])
    await blobs.put(jdKey(hash), new TextEncoder().encode(hash));
  await blobs.put(ownPack, new Uint8Array([1]));

  return { canonical, first, second, sharedOld, sharedKeep, uniqueOld, ownPack };
}

const visible = async () =>
  (await searchJobs(db, { limit: 100 }, NOW)).jobs.map((j) => j.id).sort((a, b) => a - b);

describe("source retirement", () => {
  it("previews exactly what the write does, and a dry run changes nothing", async () => {
    const ids = await scenario();
    const jobsBefore = await db.select().from(schema.jobs);
    const sourcesBefore = await db.select().from(schema.sources);
    const runsBefore = await db.select().from(schema.runs);

    const dry = await retireSources(db, [OLD], { dryRun: true, now: NOW });
    expect(dry).toEqual({
      sources: [OLD],
      jobs: 3,
      rawKeys: [ids.ownPack],
      orphanJdHashes: [UNIQUE],
      dryRun: true,
    });
    expect(await db.select().from(schema.jobs)).toEqual(jobsBefore);
    expect(await db.select().from(schema.sources)).toEqual(sourcesBefore);
    expect(await db.select().from(schema.runs)).toEqual(runsBefore);

    const real = await retireSources(db, [OLD], { dryRun: false, now: NOW });
    expect(real).toEqual({ ...dry, dryRun: false });
    expect(await getJob(db, ids.canonical)).toBeUndefined();
  });

  it("removes only the retired board's jobs and sources, preserving history and every blob", async () => {
    const ids = await scenario();
    const blobsBefore = blobs.keys().sort();
    const runsBefore = await db.select().from(schema.runs);

    const result = await retireSources(db, [OLD], { now: NOW });

    expect(result).toMatchObject({ sources: [OLD], jobs: 3, dryRun: false });
    expect((await db.select().from(schema.sources)).map((s) => s.id)).toEqual([KEEP]);
    for (const id of [ids.canonical, ids.sharedOld, ids.uniqueOld])
      expect(await getJob(db, id)).toBeUndefined();
    for (const id of [ids.first, ids.second, ids.sharedKeep])
      expect(await getJob(db, id)).toBeDefined();

    expect(await db.select().from(schema.runs)).toEqual(runsBefore);
    expect(blobs.keys().sort()).toEqual(blobsBefore);
    expect(await blobs.has(jdKey(SHARED))).toBe(true);
    // A description another board also references is never an orphan candidate.
    expect(result.orphanJdHashes).toEqual([UNIQUE]);
    expect(result.rawKeys).toEqual([ids.ownPack]);
  });

  it("hands a duplicate group to the next surviving canonical and stays visible", async () => {
    const ids = await scenario();

    await retireSources(db, [OLD], { now: NOW });

    expect((await getJob(db, ids.first))?.dupOf).toBeNull();
    expect((await getJob(db, ids.first))?.updatedAt).toBe(NOW);
    expect((await getJob(db, ids.second))?.dupOf).toBe(ids.first);
    expect((await getJob(db, ids.second))?.updatedAt).toBe(NOW);
    expect(await visible()).toEqual([ids.first, ids.sharedKeep].sort((a, b) => a - b));
  });

  it("is idempotent for unknown and already-retired ids", async () => {
    await scenario();
    const empty = { sources: [], jobs: 0, rawKeys: [], orphanJdHashes: [], dryRun: false };

    expect(await retireSources(db, [], { now: NOW })).toEqual(empty);
    expect(await retireSources(db, ["greenhouse:missing"], { now: NOW })).toEqual(empty);
    await retireSources(db, [OLD], { now: NOW });
    expect(await retireSources(db, [OLD, "greenhouse:missing"], { now: NOW })).toEqual(empty);
  });

  it("refuses a source with a running run before writing anything", async () => {
    await scenario();
    await addRun("run-live", OLD, NOW - 10, null, "running");
    const jobsBefore = await db.select().from(schema.jobs);
    const sourcesBefore = await db.select().from(schema.sources);

    await expect(retireSources(db, [OLD], { dryRun: true, now: NOW })).rejects.toMatchObject({
      status: 409,
    });
    await expect(retireSources(db, [OLD], { dryRun: false, now: NOW })).rejects.toMatchObject({
      status: 409,
    });
    expect(await db.select().from(schema.jobs)).toEqual(jobsBefore);
    expect(await db.select().from(schema.sources)).toEqual(sourcesBefore);
  });

  it("bounds the request by source count and by stored rows", async () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `greenhouse:s${i}`);
    await expect(retireSources(db, tooMany)).rejects.toMatchObject({ status: 409 });

    await seedSources();
    const rows = Array.from({ length: RETIRE_MAX_ROWS + 1 }, (_, i) => ({
      sourceId: OLD,
      postingId: `bulk-${i}`,
      company: "Old Co",
      companySlug: "old-co",
      title: `Job ${i}`,
      excerpt: "x",
      jdHash: KEPT,
      jdBytes: 1,
      sourceHash: h("d"),
      facts: {},
      sortAt: i,
      firstSeenAt: NOW,
      updatedAt: NOW,
    }));
    for (let i = 0; i < rows.length; i += 500)
      await db.insert(schema.jobs).values(rows.slice(i, i + 500));

    await expect(retireSources(db, [OLD], { now: NOW })).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(schema.sources)).map((s) => s.id)).toEqual([OLD, KEEP]);

    const history = Array.from({ length: RETIRE_MAX_ROWS + 1 }, (_, i) => ({
      id: `run-bound-${i}`,
      sourceId: KEEP,
      runnerId: "mac",
      collectorVersion: "t",
      startedAt: NOW - i,
      status: "complete" as const,
    }));
    for (let i = 0; i < history.length; i += 500)
      await db.insert(schema.runs).values(history.slice(i, i + 500));

    await expect(retireSources(db, [KEEP], { now: NOW })).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(schema.sources)).map((s) => s.id)).toEqual([OLD, KEEP]);
  });
});
