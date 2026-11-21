import { prepareJob } from "@tallo/catalog";
import type { MappedJob, SourceConfig } from "@tallo/contracts";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { applyJobs, finalize, jdKey, memoryBlobs, schema, startRun } from "../src/index.ts";
import { testDb, writeCost } from "../src/testing.ts";

// A 304 skips a run's work. It must never close, age or reopen a job, and the stored validator must
// only survive a listing that was complete and fully applied (CLAUDE.md rule 2).

const source: SourceConfig = {
  id: "greenhouse:acme",
  platform: "greenhouse",
  key: "acme",
  company: "Acme Corp",
  params: {},
};
const T = 1_800_000_000;
const DAY = 86400;
const V = "1.1|W/abc";
let db: ReturnType<typeof testDb>;
let blobs: ReturnType<typeof memoryBlobs>;
let n = 0;

beforeEach(() => {
  db = testDb();
  blobs = memoryBlobs();
  n = 0;
});

const mapped = (id: string): MappedJob => ({
  postingId: `p${id}`,
  title: `Software Engineer ${id}`,
  description: `Build things ${id}`,
  locations: [{ text: "Austin, TX", countryCode: "US", primary: true }],
  compensation: [],
  experience: [],
  extras: {},
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
  validator: V,
  ...over,
});
const start = async (now: number) => {
  const runId = `run-${++n}`;
  const started = await startRun(
    db,
    { runId, source, runnerId: "mac", collectorVersion: "t", startedAt: now },
    now,
  );
  return { runId, ...started };
};
async function write(runId: string, ids: string[], now: number) {
  const prepared = await Promise.all(ids.map((i) => prepareJob(mapped(i), source, "a".repeat(64))));
  for (const p of prepared) await blobs.put(jdKey(p.facts.jdHash), p.jd);
  await applyJobs(
    db,
    blobs,
    runId,
    prepared.map((p) => p.facts),
    now,
  );
}
const stored = async () =>
  (await db.select().from(schema.sources).where(eq(schema.sources.id, source.id)))[0]
    ?.listingValidator;
const jobRows = () =>
  db
    .select({
      id: schema.jobs.postingId,
      absent: schema.jobs.absentRuns,
      closed: schema.jobs.closedAt,
    })
    .from(schema.jobs);

/** A first run that lists p1 and p2 completely and stores the validator. */
async function firstRun() {
  const { runId } = await start(T);
  await write(runId, ["1", "2"], T);
  await finalize(db, runId, fin(["p1", "p2"]), T);
}

describe("listing validator", () => {
  it("has none before any run", async () => {
    expect((await start(T)).validator).toBeNull();
  });

  it("stores the validator of a complete, fully applied run and hands it to the next start", async () => {
    await firstRun();
    expect(await stored()).toBe(V);
    expect((await start(T + DAY)).validator).toBe(V);
  });

  it.each([
    ["a partial listing", { listingComplete: false }],
    ["failed details", { detailsComplete: false }],
    ["a platform without validators", { validator: null }],
  ])("does not keep a validator after %s", async (_name, over) => {
    const { runId } = await start(T);
    await write(runId, ["1"], T);
    await finalize(db, runId, fin(["p1"], over), T);
    expect((await stored()) ?? null).toBeNull();
  });

  it("does not cache a non-authoritative empty listing", async () => {
    await firstRun();
    const { runId } = await start(T + DAY);
    const before = await jobRows();
    await finalize(db, runId, fin([], { emptyIsAuthoritative: false }), T + DAY);
    expect(await stored()).toBeNull();
    expect(await jobRows()).toEqual(before);
  });

  it("a later failed run clears the validator", async () => {
    await firstRun();
    const { runId } = await start(T + DAY);
    await finalize(db, runId, fin([], { listingComplete: false, validator: null }), T + DAY);
    expect(await stored()).toBeNull();
  });

  it("applying jobs clears it until the run finishes cleanly", async () => {
    await firstRun();
    const { runId } = await start(T + DAY);
    await write(runId, ["3"], T + DAY);
    expect(await stored()).toBeNull(); // the run may die here: the stored listing no longer matches the catalog
    await finalize(db, runId, fin(["p1", "p2", "p3"], { validator: "1.1|W/new" }), T + DAY);
    expect(await stored()).toBe("1.1|W/new");
  });

  it("is not kept while a job is on its first absence, so the next run lists and can close it", async () => {
    await firstRun();
    const { runId } = await start(T + DAY);
    await finalize(db, runId, fin(["p1"]), T + DAY); // p2 absent once
    expect((await jobRows()).find((j) => j.id === "p2")?.absent).toBe(1);
    expect(await stored()).toBeNull();
  });
});

describe("a 304 run", () => {
  // Adversarial: a platform that calls an empty listing authoritative must still not close anything on a 304.
  const notModified = (over = {}) =>
    fin([], { notModified: true, emptyIsAuthoritative: true, ...over });

  it("closes nothing, ages nothing, keeps the validator and still counts as a complete run", async () => {
    await firstRun();
    const before = await jobRows();
    const { runId } = await start(T + 30 * DAY);
    const result = await finalize(db, runId, notModified(), T + 30 * DAY);
    expect(result).toEqual({ status: "complete", closureApplied: false, closed: 0, reopened: 0 });
    expect(await jobRows()).toEqual(before);
    expect(before.every((j) => j.absent === 0 && j.closed === null)).toBe(true);
    expect(await stored()).toBe(V);
    const source_ = (await db.select().from(schema.sources))[0]!;
    expect(source_).toMatchObject({
      lastStatus: "complete",
      lastCompleteRunAt: T + 30 * DAY,
      lastListedAt: T + 30 * DAY,
      failureCount: 0,
    });
    const run = (await db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]!;
    expect(run).toMatchObject({ status: "complete", seen: null, closed: null });
  });

  it("repeated 304s never close jobs, however many", async () => {
    await firstRun();
    for (let i = 1; i <= 5; i++) {
      const { runId } = await start(T + i * DAY);
      await finalize(db, runId, notModified(), T + i * DAY);
    }
    expect((await jobRows()).every((j) => j.closed === null && j.absent === 0)).toBe(true);
  });

  it("without a stored validator it is a failed run, not a complete one", async () => {
    const { runId } = await start(T);
    await write(runId, ["1"], T);
    await finalize(db, runId, fin(["p1"], { validator: null }), T);
    const next = await start(T + DAY);
    const result = await finalize(db, next.runId, notModified(), T + DAY);
    expect(result).toMatchObject({ status: "partial", closureApplied: false, closed: 0 });
    expect((await jobRows()).every((j) => j.closed === null && j.absent === 0)).toBe(true);
    const source_ = (await db.select().from(schema.sources))[0]!;
    expect(source_.failureCount).toBe(1);
  });

  it("with a validator that is not the stored one it is a failed run", async () => {
    await firstRun();
    const { runId } = await start(T + DAY);
    const result = await finalize(db, runId, notModified({ validator: "1.1|W/forged" }), T + DAY);
    expect(result.status).toBe("partial");
    expect(result.closureApplied).toBe(false);
    expect(await stored()).toBeNull();
  });

  it("an unchanged board costs one run row, one source row and no job writes", async () => {
    await firstRun();
    const before = writeCost(db);
    const { runId } = await start(T + DAY);
    await finalize(db, runId, notModified(), T + DAY);
    const after = writeCost(db);
    // run insert + run update + source upsert + source update; no job or group row is touched.
    expect(after.rows - before.rows).toBe(4);
  });
});
