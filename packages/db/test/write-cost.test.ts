import { prepareJob } from "@tallo/catalog";
import type { MappedJob, SourceConfig } from "@tallo/contracts";
import { eq, type SQL, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyJobs,
  finalize,
  jdKey,
  memoryBlobs,
  purgeClosed,
  rebuildDuplicates,
  schema,
  startRun,
} from "../src/index.ts";
import { searchJobs, testDb, writeCost } from "../src/testing.ts";

// Guards the write-cost fixes (docs/architecture.md, "Write cost"). Each test fails on the code it guards.

const source: SourceConfig = {
  id: "greenhouse:acme",
  platform: "greenhouse",
  key: "acme",
  company: "Acme Corp",
  params: {},
};
const T = 1_800_000_000;
const DAY = 86400;
let db: ReturnType<typeof testDb>;
let blobs: ReturnType<typeof memoryBlobs>;
let n = 0;

beforeEach(() => {
  db = testDb();
  blobs = memoryBlobs();
  n = 0;
});

const mapped = (id: string, over: Partial<MappedJob> = {}): MappedJob => ({
  postingId: `p${id}`,
  title: `Software Engineer ${id}`,
  description: `Build things ${id}`,
  locations: [{ text: "Austin, TX", countryCode: "US", primary: true }],
  compensation: [],
  experience: [],
  extras: {},
  ...over,
});
const fin = (seenIds: string[], over = {}) => ({
  seenIds,
  listingComplete: true,
  detailsComplete: true,
  emptyIsAuthoritative: false,
  requests: 1,
  finishedAt: 1,
  rawKey: null,
  issues: [],
  boardNotFound: false,
  ...over,
});
const start = async (now: number) => {
  const runId = `run-${++n}`;
  await startRun(
    db,
    { runId, source, runnerId: "mac", collectorVersion: "t", startedAt: now },
    now,
  );
  return runId;
};
async function ingest(runId: string, jobs: MappedJob[], now: number) {
  const prepared = await Promise.all(jobs.map((j) => prepareJob(j, source, "a".repeat(64))));
  for (const p of prepared) await blobs.put(jdKey(p.facts.jdHash), p.jd);
  return applyJobs(
    db,
    blobs,
    runId,
    prepared.map((p) => p.facts),
    now,
  );
}
/** One complete run: apply `jobs`, then finalize with `seen` listed. */
async function sync(jobs: MappedJob[], seen: string[], now: number) {
  const runId = await start(now);
  await ingest(runId, jobs, now);
  return finalize(db, runId, fin(seen), now);
}
const row = async (postingId: string) =>
  (await db.select().from(schema.jobs).where(eq(schema.jobs.postingId, postingId)))[0]!;
async function queryPlan(query: SQL): Promise<string> {
  const rows = await db.all<unknown[]>(sql`EXPLAIN QUERY PLAN ${query}`);
  return rows.map((r) => String(r.at(-1))).join("\n");
}
const ids = (count: number) => Array.from({ length: count }, (_, i) => `${i}`);

describe("re-applying what is stored", () => {
  it("writes only the run's counters when the postings are identical", async () => {
    const jobs = ids(5).map((i) => mapped(i));
    await sync(
      jobs,
      jobs.map((j) => j.postingId),
      T,
    );
    const runId = await start(T + DAY);
    const before = writeCost(db);
    await ingest(runId, jobs, T + DAY);
    // The run row and the source's listing time. No job row, no index, no FTS row.
    expect(writeCost(db).rows - before.rows).toBe(2);
  });

  it("does not check the blob store for a description the row already stores", async () => {
    const jobs = ids(3).map((i) => mapped(i));
    await sync(
      jobs,
      jobs.map((j) => j.postingId),
      T,
    );
    const checked: string[] = [];
    const counting = {
      ...blobs,
      has: async (key: string) => {
        checked.push(key);
        return blobs.has(key);
      },
    };
    const prepared = await Promise.all(jobs.map((j) => prepareJob(j, source, "a".repeat(64))));
    const runId = await start(T + DAY);
    await applyJobs(
      db,
      counting,
      runId,
      prepared.map((p) => p.facts),
      T + DAY,
    );
    expect(checked).toEqual([]);

    // A description the rows do not store yet is still checked, once.
    const changed = await prepareJob(
      mapped("0", { description: "new words" }),
      source,
      "a".repeat(64),
    );
    await applyJobs(db, counting, runId, [changed.facts], T + DAY);
    expect(checked).toEqual([jdKey(changed.facts.jdHash)]);
  });
});

describe("full-text index", () => {
  it("an update that sets the indexed title to its current value writes no FTS rows", async () => {
    await sync([mapped("1")], ["p1"], T);
    const id = (await row("p1")).id;
    const before = writeCost(db);
    await db
      .update(schema.jobs)
      .set({ title: "Software Engineer 1" })
      .where(eq(schema.jobs.id, id));
    // The job row only. Before the WHEN guard, the trigger also wrote the delete and insert of the index.
    expect(writeCost(db).rows - before.rows).toBe(1);
  });

  it("a changed title is searchable under its new words only", async () => {
    await sync([mapped("1")], ["p1"], T);
    await sync([mapped("1", { title: "Quantum Analyst" })], ["p1"], T + DAY);
    expect((await searchJobs(db, { q: "quantum", limit: 10 }, T + DAY)).jobs).toHaveLength(1);
    expect((await searchJobs(db, { q: "engineer", limit: 10 }, T + DAY)).jobs).toHaveLength(0);
  });

  it("a changed location is searchable, and a location change alone keeps the group's updated_at", async () => {
    await sync([mapped("1")], ["p1"], T);
    await sync(
      [mapped("1", { locations: [{ text: "Reykjavik", countryCode: "IS", primary: true }] })],
      ["p1"],
      T + DAY,
    );
    expect((await searchJobs(db, { q: "reykjavik", limit: 10 }, T + DAY)).jobs).toHaveLength(1);
    expect((await row("p1")).updatedAt).toBe(T);
  });
});

describe("absence and reopen", () => {
  it("a first absence writes no index entries and leaves updated_at alone", async () => {
    const jobs = ids(100).map((i) => mapped(i));
    await sync(
      jobs,
      jobs.map((j) => j.postingId),
      T,
    );
    const runId = await start(T + DAY);
    const before = writeCost(db);
    await finalize(db, runId, fin(["p0"]), T + DAY);
    // The run and source rows touch indexes; the 99 absences must not (they were 4 index entries each).
    expect(writeCost(db).indexEntries - before.indexEntries).toBeLessThan(10);
    expect(await row("p1")).toMatchObject({ absentRuns: 1, closedAt: null, updatedAt: T });
  });

  it("closing bumps updated_at so the regroup sees the group change", async () => {
    await sync([mapped("0"), mapped("1")], ["p0", "p1"], T);
    await sync([], ["p0"], T + DAY);
    expect(await row("p1")).toMatchObject({ absentRuns: 1, closedAt: null, updatedAt: T });
    await sync([], ["p0"], T + 2 * DAY);
    expect(await row("p1")).toMatchObject({ closedAt: T + 2 * DAY, updatedAt: T + 2 * DAY });
  });

  it("reopening by finalize or by applyJobs clears closed_at and bumps updated_at", async () => {
    await sync([mapped("0"), mapped("1")], ["p0", "p1"], T);
    await sync([], ["p0"], T + DAY);
    await sync([], ["p0"], T + 2 * DAY);
    const back = await start(T + 3 * DAY);
    expect(await finalize(db, back, fin(["p0", "p1"]), T + 3 * DAY)).toMatchObject({ reopened: 1 });
    expect(await row("p1")).toMatchObject({
      closedAt: null,
      absentRuns: 0,
      updatedAt: T + 3 * DAY,
    });

    await sync([], ["p0"], T + 4 * DAY);
    await sync([], ["p0"], T + 5 * DAY);
    expect((await row("p1")).closedAt).toBe(T + 5 * DAY);
    const again = await start(T + 6 * DAY);
    await ingest(again, [mapped("1")], T + 6 * DAY);
    await finalize(db, again, fin(["p0", "p1"]), T + 6 * DAY);
    expect(await row("p1")).toMatchObject({ closedAt: null, updatedAt: T + 6 * DAY });
  });

  it("a run that writes nothing leaves its source's duplicate groups as they are", async () => {
    const twin = { title: "Software Engineer", description: "Same words" };
    await sync([mapped("a", twin), mapped("b", twin)], ["pa", "pb"], T);
    const b = await row("pb");
    expect(b.dupOf).not.toBeNull();
    // Corrupt the group on purpose: a regroup of this source would restore it (the rows are inside its window).
    await db.update(schema.jobs).set({ dupOf: null }).where(eq(schema.jobs.id, b.id));
    await sync([], ["pa", "pb"], T + 60);
    expect((await row("pb")).dupOf).toBeNull();
    // The same source with a change in the run regroups again.
    await sync([mapped("c", twin)], ["pa", "pb", "pc"], T + 120);
    expect((await row("pb")).dupOf).not.toBeNull();
  });
});

describe("purge", () => {
  it("keeps a description a live row still references and deletes the rest, across batches", async () => {
    // 150 postings, so the reference check runs in more than one batch of 100 hashes.
    const closing = ids(150).map((i) => mapped(i));
    await sync(
      closing,
      closing.map((j) => j.postingId),
      T,
    );
    // "keep" shares the description (hash) of posting 0, which closes; "keep" stays open.
    const keep = mapped("keep", { title: "Keep Me", description: "Build things 0" });
    await sync([...closing, keep], [...closing.map((j) => j.postingId), "pkeep"], T + DAY);
    await sync([keep], ["pkeep"], T + 2 * DAY);
    await sync([keep], ["pkeep"], T + 3 * DAY);
    expect(blobs.keys()).toHaveLength(150);

    const purged = await purgeClosed(db, blobs, 30, T + 3 * DAY + 31 * DAY);
    expect(purged).toBe(150);
    expect(blobs.keys()).toEqual([jdKey((await row("pkeep")).jdHash)]);
  });

  it("looks up referenced hashes and closed rows through indexes, not a scan of jobs", async () => {
    const hashes = await queryPlan(
      sql`SELECT DISTINCT jd_hash FROM jobs WHERE jd_hash IN (SELECT value FROM json_each(${JSON.stringify(["a"])}))`,
    );
    expect(hashes).toContain("jobs_jd_hash_idx");
    expect(hashes).not.toMatch(/SCAN jobs(?! USING)/);
    const closed = await queryPlan(
      sql`SELECT id, jd_hash FROM jobs WHERE closed_at IS NOT NULL AND closed_at < ${T} LIMIT 1000`,
    );
    expect(closed).toContain("jobs_closed_idx");
    expect(closed).not.toMatch(/SCAN jobs(?! USING)/);
  });
});

describe("regroup", () => {
  it("is not needed for a run that wrote nothing: rebuild still regroups when asked", async () => {
    // Guard: the skip in finalize must not stop the explicit rebuild, which regroups everything.
    const twin = { title: "Software Engineer", description: "Same words" };
    await sync([mapped("a", twin), mapped("b", twin)], ["pa", "pb"], T);
    await db.update(schema.jobs).set({ dupOf: null }).where(eq(schema.jobs.postingId, "pb"));
    await rebuildDuplicates(db, T + 60, { full: true });
    expect((await row("pb")).dupOf).not.toBeNull();
  });
});
