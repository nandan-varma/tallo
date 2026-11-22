import { prepareJob } from "@tallo/catalog";
import type { MappedJob, SourceConfig } from "@tallo/contracts";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyJobs,
  diff,
  finalize,
  jdKey,
  memoryBlobs,
  purgeClosed,
  reapStaleRuns,
  schema,
  staleRunsQuery,
  startRun,
} from "../src/index.ts";
import { queryPlan, testDb } from "../src/testing.ts";

const source: SourceConfig = {
  id: "smartrecruiters:acme",
  platform: "smartrecruiters",
  key: "acme",
  company: "Acme Corp",
  params: {},
};
const DAY = 86400;
const T = Math.floor(Date.now() / 1000);
let db: ReturnType<typeof testDb>;
let blobs: ReturnType<typeof memoryBlobs>;
let n = 0;

const mapped = (postingId: string, over: Partial<MappedJob> = {}): MappedJob => ({
  postingId,
  title: `Software Engineer ${postingId}`,
  description: `Build things ${postingId}`,
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
const start = async (now = T + 1000) => {
  const runId = `run-${String(++n).padStart(6, "0")}`;
  await startRun(
    db,
    { runId, source, runnerId: "mac", collectorVersion: "t", startedAt: now },
    now,
  );
  return runId;
};
const prepare = (jobs: MappedJob[]) =>
  Promise.all(jobs.map((j) => prepareJob(j, source, "a".repeat(64))));
async function ingest(runId: string, jobs: MappedJob[], now = T + 1000) {
  const prepared = await prepare(jobs);
  for (const p of prepared) await blobs.put(jdKey(p.facts.jdHash), p.jd);
  return applyJobs(
    db,
    blobs,
    runId,
    prepared.map((p) => p.facts),
    now,
  );
}
const board = async () =>
  (await db.select().from(schema.sources).where(eq(schema.sources.id, source.id)))[0]!;
const runRow = async (id: string) =>
  (await db.select().from(schema.runs).where(eq(schema.runs.id, id)))[0]!;

beforeEach(() => {
  db = testDb();
  blobs = memoryBlobs();
});

describe("complete but empty, non-authoritative listing", () => {
  const seed = async () => {
    const first = await start(T + 1000);
    await ingest(first, [mapped("1")], T + 1000);
    await finalize(db, first, fin(["1"]), T + 1000);
  };

  it("does not advance freshness, reset back-off or revive, and closes nothing", async () => {
    await seed();
    expect((await board()).lastListedAt).toBe(T + 1000);
    for (const [i, now] of [T + 2000, T + 3000, T + 4000].entries()) {
      const run = await start(now);
      const result = await finalize(db, run, fin([]), now);
      expect(result).toMatchObject({ closureApplied: false, closed: 0 });
      expect((await runRow(run)).status).toBe("partial");
      const after = await board();
      expect(after.lastListedAt).toBe(T + 1000);
      expect(after.failureCount).toBe(i + 1);
      expect(after.lastStatus).toBe("partial");
    }
    // Rule 2: the job is still open after any number of such runs.
    const jobs = await db.select().from(schema.jobs);
    expect(jobs.map((j) => [j.closedAt, j.absentRuns])).toEqual([[null, 0]]);
  });

  it("does not revive a dead board", async () => {
    await seed();
    await db.update(schema.sources).set({ status: "dead", consecutiveFailures: 5 });
    const run = await start(T + 2000);
    await finalize(db, run, fin([]), T + 2000);
    expect(await board()).toMatchObject({ status: "dead", consecutiveFailures: 5 });
  });

  it("an authoritatively empty listing still counts as a good run and closes", async () => {
    await seed();
    for (const now of [T + 2000, T + 3000]) {
      const run = await start(now);
      await finalize(db, run, fin([], { emptyIsAuthoritative: true }), now);
    }
    expect(await board()).toMatchObject({ failureCount: 0, status: "active" });
    expect((await board()).lastListedAt).toBe(T + 3000);
    expect((await db.select().from(schema.jobs))[0]!.closedAt).not.toBeNull();
  });

  it("an incomplete run never closes", async () => {
    await seed();
    for (const now of [T + 2000, T + 3000, T + 4000]) {
      const run = await start(now);
      await finalize(db, run, fin([], { listingComplete: false }), now);
    }
    expect((await db.select().from(schema.jobs))[0]!.closedAt).toBeNull();
  });
});

describe("concurrent finalize of one run", () => {
  it("counts one absence once, so the posting survives its first absent listing", async () => {
    const first = await start(T + 1000);
    await ingest(first, [mapped("1")], T + 1000);
    await finalize(db, first, fin(["1"]), T + 1000);
    const second = await start(T + 2000);
    const results = await Promise.all([
      finalize(db, second, fin(["2"]), T + 2000),
      finalize(db, second, fin(["2"]), T + 2000),
    ]);
    expect(results.map((r) => r.status)).toEqual(["complete", "complete"]);
    const [job] = await db.select().from(schema.jobs);
    expect([job!.closedAt, job!.absentRuns]).toEqual([null, 1]);
    expect((await board()).failureCount).toBe(0);
  });
});

describe("purge versus applyJobs blob reuse", () => {
  const purgeAt = T + 31 * DAY;
  const closedJob = async () => {
    const run = await start(T + 1000);
    const [p] = await prepare([mapped("1")]);
    await blobs.put(jdKey(p!.facts.jdHash), p!.jd);
    await applyJobs(db, blobs, run, [p!.facts], T + 1000);
    await db.update(schema.jobs).set({ closedAt: T });
    return p!;
  };

  it("puts the blob back when a job started referencing it while it was deleted", async () => {
    const p = await closedJob();
    const [row] = await db.select().from(schema.jobs).limit(1);
    const { id: _id, ...rest } = row!;
    const realDelete = blobs.delete;
    blobs.delete = async (key) => {
      await realDelete(key);
      // A concurrent applyJobs commits a new job that reuses this description.
      await db.insert(schema.jobs).values({ ...rest, postingId: "2", closedAt: null });
    };
    expect(await purgeClosed(db, blobs, 30, purgeAt)).toBe(1);
    expect(await blobs.has(jdKey(p.facts.jdHash))).toBe(true);
  });

  it("still deletes a blob nothing references", async () => {
    const p = await closedJob();
    expect(await purgeClosed(db, blobs, 30, purgeAt)).toBe(1);
    expect(await blobs.has(jdKey(p.facts.jdHash))).toBe(false);
  });

  it("applyJobs reports a blob that vanished after its check and forces a resend", async () => {
    const run = await start(T + 1000);
    const [p] = await prepare([mapped("1")]);
    await blobs.put(jdKey(p!.facts.jdHash), p!.jd);
    // Purge deletes the blob right after applyJobs saw it: the first has() is true, later ones false.
    const realHas = blobs.has;
    let first = true;
    blobs.has = async (key) => {
      const had = await realHas(key);
      if (first) {
        first = false;
        await blobs.delete(key);
      }
      return had;
    };
    const result = await applyJobs(db, blobs, run, [p!.facts], T + 1000);
    expect(result.missingBlobs).toEqual([p!.facts.jdHash]);
    // The posting is sent again by the next diff, so the runner re-uploads its description.
    expect(await diff(db, run, [{ id: "1", hash: p!.facts.sourceHash }])).toEqual(["1"]);
  });

  it("applyJobs reports nothing when the blob is still there", async () => {
    const run = await start(T + 1000);
    expect(await ingest(run, [mapped("1")])).toMatchObject({ applied: 1, missingBlobs: [] });
  });
});

describe("reapStaleRuns atomicity", () => {
  const LEASE = 3 * 3600;
  type Batch = (statements: never) => Promise<unknown>;
  const withBatch = (hook: (real: Batch) => Batch) =>
    new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") return hook(target.batch.bind(target) as Batch);
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

  it("a failed write leaves the run running, so a retry reaps it and counts the failure once", async () => {
    const stuck = await start(T + 1000);
    const reapAt = T + 1000 + LEASE;
    const crashing = withBatch(() => async () => {
      throw new Error("worker died");
    });
    await expect(reapStaleRuns(crashing, reapAt)).rejects.toThrow("worker died");
    expect((await runRow(stuck)).status).toBe("running");
    expect((await board()).failureCount).toBe(0);

    expect(await reapStaleRuns(db, reapAt + 1)).toBe(1);
    expect((await runRow(stuck)).status).toBe("partial");
    expect((await board()).failureCount).toBe(1);
    expect(await reapStaleRuns(db, reapAt + 2)).toBe(0);
    expect((await board()).failureCount).toBe(1);
  });

  it("a finalize that lands after the read is not counted as a failure", async () => {
    const stuck = await start(T + 1000);
    const reapAt = T + 1000 + LEASE;
    const racing = withBatch((real) => async (statements) => {
      await finalize(db, stuck, fin([], { emptyIsAuthoritative: true }), reapAt);
      return real(statements);
    });
    expect(await reapStaleRuns(racing, reapAt)).toBe(0);
    expect((await runRow(stuck)).status).toBe("complete");
    expect(await board()).toMatchObject({ failureCount: 0, lastStatus: "complete" });
  });
});

describe("runs_running_idx", () => {
  it("the lease scan seeks the partial index instead of scanning runs", () => {
    const d = testDb();
    const plan = queryPlan(d, staleRunsQuery(d, T)).join("\n");
    expect(plan).toContain("USING INDEX runs_running_idx");
    expect(plan).not.toMatch(/SCAN runs\b/);
  });
});
