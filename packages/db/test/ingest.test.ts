import { prepareJob } from "@tallo/catalog";
import type { MappedJob, SourceConfig } from "@tallo/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyJobs,
  diff,
  finalize,
  getJob,
  jdKey,
  memoryBlobs,
  purgeClosed,
  searchJobs,
  startRun,
} from "../src/index.ts";
import { testDb } from "../src/testing.ts";

const source: SourceConfig = {
  id: "greenhouse:acme",
  platform: "greenhouse",
  key: "acme",
  company: "Acme Corp",
  params: {},
};
const loc = (text: string, countryCode: string) => ({ text, countryCode, primary: true });

const mapped = (postingId: string, over: Partial<MappedJob> = {}): MappedJob => ({
  postingId,
  title: `Software Engineer ${postingId}`,
  description: `Build things ${postingId}`,
  locations: [loc("Austin, TX", "US")],
  compensation: [],
  experience: [],
  extras: {},
  ...over,
});

let db: ReturnType<typeof testDb>;
let blobs: ReturnType<typeof memoryBlobs>;
let n = 0;
const fin = (seenIds: string[], over = {}) => ({
  seenIds,
  listingComplete: true,
  detailsComplete: true,
  emptyIsAuthoritative: false,
  requests: 1,
  finishedAt: 1,
  rawKey: null,
  issues: [],
  ...over,
});
const start = async (now = 1000) => {
  const runId = `run-${String(++n).padStart(6, "0")}`;
  await startRun(
    db,
    { runId, source, runnerId: "mac", collectorVersion: "t", startedAt: now },
    now,
  );
  return runId;
};
/** Prepare, upload blobs, apply: what the runner does. */
async function ingest(runId: string, jobs: MappedJob[], hash = "a".repeat(64), now = 1000) {
  const prepared = await Promise.all(jobs.map((j) => prepareJob(j, source, hash)));
  for (const p of prepared) await blobs.put(jdKey(p.facts.jdHash), p.jd);
  return applyJobs(
    db,
    blobs,
    runId,
    prepared.map((p) => p.facts),
    now,
  );
}

beforeEach(() => {
  db = testDb();
  blobs = memoryBlobs();
});

describe("ingest", () => {
  it("applies jobs, reports what changed, and is searchable", async () => {
    const run = await start();
    expect(await ingest(run, [mapped("1"), mapped("2")])).toMatchObject({
      applied: 2,
      missingBlobs: [],
    });
    const hit = await searchJobs(db, { q: "software eng", limit: 10 });
    expect(hit.jobs.map((j) => j.company)).toEqual(["Acme Corp", "Acme Corp"]);
    expect((await searchJobs(db, { q: "nonexistent", limit: 10 })).jobs).toHaveLength(0);
  });

  it("diff returns only new or changed postings", async () => {
    const run = await start();
    await ingest(run, [mapped("1")], "a".repeat(64));
    await finalize(db, run, fin(["1"]));
    const second = await start(2000);
    expect(
      await diff(db, second, [
        { id: "1", hash: "a".repeat(64) },
        { id: "2", hash: "b".repeat(64) },
      ]),
    ).toEqual(["2"]);
    expect(await diff(db, second, [{ id: "1", hash: "c".repeat(64) }])).toEqual(["1"]);
  });

  it("skips jobs whose JD blob is missing and reports the hash", async () => {
    const run = await start();
    const [p] = [await prepareJob(mapped("1"), source, "a".repeat(64))];
    const result = await applyJobs(db, blobs, run, [p!.facts], 1000);
    expect(result).toEqual({ applied: 0, missingBlobs: [p!.facts.jdHash] });
  });

  it("refuses a second concurrent run for the same source, but is idempotent per run id", async () => {
    const run = await start();
    await expect(start()).rejects.toMatchObject({ status: 409 });
    await expect(
      startRun(
        db,
        { runId: run, source, runnerId: "mac", collectorVersion: "t", startedAt: 1000 },
        1000,
      ),
    ).resolves.toBeUndefined();
  });

  it("pages with a stable keyset cursor", async () => {
    const run = await start();
    await ingest(
      run,
      ["1", "2", "3", "4", "5"].map((id, i) =>
        mapped(id, { postedAt: `2026-01-0${i + 1}T00:00:00Z` }),
      ),
    );
    const first = await searchJobs(db, { limit: 2 });
    const second = await searchJobs(db, { limit: 2, cursor: first.nextCursor! });
    const third = await searchJobs(db, { limit: 2, cursor: second.nextCursor! });
    const titles = [...first.jobs, ...second.jobs, ...third.jobs].map((j) => j.title);
    expect(titles).toEqual(["5", "4", "3", "2", "1"].map((i) => `Software Engineer ${i}`));
    expect(third.nextCursor).toBeNull();
  });

  it("hides out-of-scope jobs by default but keeps them", async () => {
    const run = await start();
    await ingest(run, [
      mapped("1"),
      mapped("2", { title: "Registered Nurse", locations: [loc("Berlin, Germany", "DE")] }),
    ]);
    expect((await searchJobs(db, { limit: 10 })).jobs).toHaveLength(1);
    expect((await searchJobs(db, { limit: 10, all: true })).jobs).toHaveLength(2);
  });

  it("filters by pay and experience", async () => {
    const run = await start();
    await ingest(run, [
      mapped("1", { description: "Pay $200,000 - $250,000 per year. 8+ years of experience." }),
      mapped("2", { description: "Pay $90,000 - $110,000 per year. 1+ years of experience." }),
      mapped("3"),
    ]);
    expect(
      (await searchJobs(db, { limit: 10, salaryMin: 180000 })).jobs.map((j) => j.title),
    ).toEqual(["Software Engineer 1"]);
    expect(
      (await searchJobs(db, { limit: 10, maxExperience: 2 })).jobs.map((j) => j.title).sort(),
    ).toEqual(["Software Engineer 2", "Software Engineer 3"]);
  });
});

describe("closure", () => {
  const listed = async (ids: string[], now: number, over = {}) => {
    const run = await start(now);
    await ingest(
      run,
      ids.map((id) => mapped(id)),
      "a".repeat(64),
      now,
    );
    return finalize(db, run, fin(ids, over), now);
  };
  const open = async () => (await searchJobs(db, { limit: 50 })).jobs.length;

  it("closes a job only after consecutive complete runs omit it, and reopens on return", async () => {
    await listed(["1", "2"], 1000);
    expect(await open()).toBe(2);
    const emptyRun = async (now: number, over = {}) => {
      const run = await start(now);
      return finalize(db, run, fin(["1"], over), now);
    };
    expect((await emptyRun(2000)).closed).toBe(0);
    expect(await open()).toBe(2);
    expect((await emptyRun(3000)).closed).toBe(1);
    expect(await open()).toBe(1);
    const back = await start(4000); // job 2 is unchanged, so the runner sends no facts for it
    expect(await finalize(db, back, fin(["1", "2"]), 4000)).toMatchObject({ reopened: 1 });
    expect(await open()).toBe(2);
  });

  it("never closes on an incomplete run", async () => {
    await listed(["1", "2"], 1000);
    for (const now of [2000, 3000, 4000]) {
      const run = await start(now);
      expect(await finalize(db, run, fin(["1"], { listingComplete: false }), now)).toMatchObject({
        status: "partial",
        closureApplied: false,
      });
    }
    expect(await open()).toBe(2);
  });

  it("does not treat an ambiguous empty listing as proof, but does an authoritative one", async () => {
    await listed(["1"], 1000);
    for (const now of [2000, 3000]) {
      const run = await start(now);
      expect((await finalize(db, run, fin([]), now)).closureApplied).toBe(false);
    }
    expect(await open()).toBe(1);
    for (const now of [4000, 5000]) {
      const run = await start(now);
      await finalize(db, run, fin([], { emptyIsAuthoritative: true }), now);
    }
    expect(await open()).toBe(0);
  });

  it("finalize is idempotent", async () => {
    const run = await start();
    const first = await finalize(db, run, fin(["1"]));
    expect(await finalize(db, run, fin(["1"]))).toEqual(first);
  });

  it("purges long-closed jobs and their orphaned blobs", async () => {
    await listed(["1", "2"], 1000);
    for (const now of [2000, 3000]) {
      const run = await start(now);
      await finalize(db, run, fin(["1"]), now);
    }
    const closedId = (await searchJobs(db, { limit: 10, all: true })).jobs.find((j) =>
      j.title.endsWith("2"),
    );
    expect(closedId).toBeUndefined();
    expect(await purgeClosed(db, blobs, 30, 3000 + 31 * 86400)).toBe(1);
    expect(blobs.keys()).toHaveLength(1);
  });
});

describe("getJob", () => {
  it("returns facts including rich detail", async () => {
    const run = await start();
    await ingest(run, [mapped("1", { extras: { team: "x" } })]);
    const { jobs } = await searchJobs(db, { limit: 1 });
    const job = await getJob(db, jobs[0]!.id);
    expect(job?.facts).toMatchObject({ platform: "greenhouse", extras: { team: "x" } });
  });
});
