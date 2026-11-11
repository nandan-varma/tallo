import { prepareJob } from "@tallo/catalog";
import type { MappedJob, SourceConfig } from "@tallo/contracts";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyJobs,
  diff,
  finalize,
  getJob,
  jdKey,
  listSources,
  memoryBlobs,
  pruneRuns,
  purgeClosed,
  rawKey,
  reapStaleRuns,
  reviveSources,
  schema,
  searchJobs,
  startRun,
  storeRawPack,
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

const T = Math.floor(Date.now() / 1000);
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
/** Prepare, upload blobs, apply: what the runner does. */
async function ingest(runId: string, jobs: MappedJob[], hash = "a".repeat(64), now = T + 1000) {
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
    const second = await start(T + 2000);
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
    const result = await applyJobs(db, blobs, run, [p!.facts], T + 1000);
    expect(result).toEqual({ applied: 0, missingBlobs: [p!.facts.jdHash] });
  });

  it("refuses a second concurrent run for the same source, but is idempotent per run id", async () => {
    const run = await start();
    await expect(start()).rejects.toMatchObject({ status: 409 });
    await expect(
      startRun(
        db,
        { runId: run, source, runnerId: "mac", collectorVersion: "t", startedAt: T + 1000 },
        T + 1000,
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

  it("lists every job the source gave, whatever its place or kind of work", async () => {
    const run = await start();
    await ingest(run, [
      mapped("1"),
      mapped("2", { title: "Registered Nurse", locations: [loc("Berlin, Germany", "DE")] }),
    ]);
    expect((await searchJobs(db, { limit: 10 })).jobs).toHaveLength(2);
  });

  it("shows the source's stated pay line in its own interval, and only stated pay", async () => {
    const run = await start();
    await ingest(run, [
      mapped("1", {
        compensation: [{ min: 50, max: 60, currency: "USD", interval: "hour", component: "base" }],
      }),
      mapped("2", {
        // Inferred from text: never used for a pay line.
        compensation: [
          { min: 200000, currency: "USD", interval: "year", component: "base", inferred: true },
        ],
      }),
      mapped("3", { description: "Pay $200,000 - $250,000 per year." }),
    ]);
    const pay = Object.fromEntries(
      (await searchJobs(db, { limit: 10 })).jobs.map((j) => [j.title, j.pay]),
    );
    expect(pay).toEqual({
      "Software Engineer 1": "USD 50-60 per hour",
      "Software Engineer 2": null,
      "Software Engineer 3": null,
    });
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
    await listed(["1", "2"], T + 1000);
    expect(await open()).toBe(2);
    const emptyRun = async (now: number, over = {}) => {
      const run = await start(now);
      return finalize(db, run, fin(["1"], over), now);
    };
    expect((await emptyRun(T + 2000)).closed).toBe(0);
    expect(await open()).toBe(2);
    expect((await emptyRun(T + 3000)).closed).toBe(1);
    expect(await open()).toBe(1);
    const back = await start(T + 4000); // job 2 is unchanged, so the runner sends no facts for it
    expect(await finalize(db, back, fin(["1", "2"]), T + 4000)).toMatchObject({ reopened: 1 });
    expect(await open()).toBe(2);
  });

  it("never closes on an incomplete run", async () => {
    await listed(["1", "2"], T + 1000);
    for (const now of [T + 2000, T + 3000, T + 4000]) {
      const run = await start(now);
      expect(await finalize(db, run, fin(["1"], { listingComplete: false }), now)).toMatchObject({
        status: "partial",
        closureApplied: false,
      });
    }
    expect(await open()).toBe(2);
  });

  it("does not treat an ambiguous empty listing as proof, but does an authoritative one", async () => {
    await listed(["1"], T + 1000);
    for (const now of [T + 2000, T + 3000]) {
      const run = await start(now);
      expect((await finalize(db, run, fin([]), now)).closureApplied).toBe(false);
    }
    expect(await open()).toBe(1);
    for (const now of [T + 4000, T + 5000]) {
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
    await listed(["1", "2"], T + 1000);
    for (const now of [T + 2000, T + 3000]) {
      const run = await start(now);
      await finalize(db, run, fin(["1"]), now);
    }
    const closed = (await searchJobs(db, { limit: 10 })).jobs.find((j) => j.title.endsWith("2"));
    expect(closed).toBeUndefined();
    expect(await purgeClosed(db, blobs, 30, T + 3000 + 31 * 86400)).toBe(1);
    expect(blobs.keys()).toHaveLength(1);
  });
});

describe("staleness", () => {
  it("hides jobs from sources that stopped listing, unless asked", async () => {
    const run = await start(T + 1000);
    await ingest(run, [mapped("1")], "a".repeat(64), T + 1000);
    await finalize(db, run, fin(["1"]), T + 1000);
    const day = 86400;
    expect((await searchJobs(db, { limit: 10 }, T + 1000 + 6 * day)).jobs).toHaveLength(1);
    expect((await searchJobs(db, { limit: 10 }, T + 1000 + 15 * day)).jobs).toHaveLength(0);
    expect(
      (await searchJobs(db, { limit: 10, includeStale: true }, T + 1000 + 15 * day)).jobs,
    ).toHaveLength(1);
    expect((await listSources(db, T + 1000 + 8 * day))[0]?.freshness).toBe("stale");
    expect((await listSources(db, T + 1000 + 15 * day))[0]?.freshness).toBe("hidden");
  });

  it("an incomplete listing still counts as listing, a failed one does not", async () => {
    const run = await start(T + 1000);
    await ingest(run, [mapped("1")], "a".repeat(64), T + 1000);
    await finalize(db, run, fin(["1"], { listingComplete: false }), T + 1000);
    const failed = await start(T + 2000);
    await finalize(db, failed, fin([], { listingComplete: false }), T + 2000 + 20 * 86400);
    expect((await listSources(db, T + 1000 + 5 * 86400))[0]?.freshness).toBe("fresh");
    expect((await listSources(db, T + 1000 + 20 * 86400))[0]?.freshness).toBe("hidden");
  });

  it("a complete run with unchanged postings (no facts sent) makes a stale source visible again", async () => {
    const day = 86400;
    const first = await start(T + 1000);
    await ingest(first, [mapped("1")], "a".repeat(64), T + 1000);
    await finalize(db, first, fin(["1"]), T + 1000);
    const later = T + 1000 + 20 * day;
    // Every posting is unchanged, so the runner calls finalize without applyJobs.
    const second = await start(later);
    await finalize(db, second, fin(["1"]), later);
    expect((await listSources(db, later))[0]?.freshness).toBe("fresh");
    expect((await searchJobs(db, { limit: 10 }, later)).jobs).toHaveLength(1);
  });

  it("a partial run that listed postings advances the listing time", async () => {
    const day = 86400;
    const first = await start(T + 1000);
    await ingest(first, [mapped("1")], "a".repeat(64), T + 1000);
    await finalize(db, first, fin(["1"]), T + 1000);
    const later = T + 1000 + 20 * day;
    const partial = await start(later);
    await finalize(db, partial, fin(["1"], { listingComplete: false }), later);
    expect((await listSources(db, later))[0]?.freshness).toBe("fresh");
  });

  it("a failed run that listed nothing does not advance the listing time", async () => {
    const day = 86400;
    const first = await start(T + 1000);
    await finalize(db, first, fin(["1"]), T + 1000);
    const failed = T + 1000 + 20 * day;
    const run = await start(failed);
    await finalize(db, run, fin([], { listingComplete: false }), failed);
    expect((await listSources(db, failed))[0]?.freshness).toBe("hidden");
  });
});

describe("board health", () => {
  const health = async () => (await listSources(db)).find((s) => s.id === source.id);
  /** A run that fails its listing. `notFound` is the HTTP 404 signal from the runner. */
  const failed = async (now: number, notFound: boolean) => {
    const run = await start(now);
    return finalize(db, run, fin([], { listingComplete: false, boardNotFound: notFound }), now);
  };

  it("marks a board dead after consecutive 404 runs, and says so in the source row", async () => {
    await failed(T + 1000, true);
    await failed(T + 2000, true);
    expect(await health()).toMatchObject({ status: "active", consecutiveFailures: 2 });
    await failed(T + 3000, true);
    expect(await health()).toMatchObject({ status: "dead", consecutiveFailures: 3 });
  });

  it("a blocked run (not a 404) never advances the streak", async () => {
    await failed(T + 1000, true);
    await failed(T + 2000, true);
    await failed(T + 3000, false);
    await failed(T + 4000, false);
    expect(await health()).toMatchObject({ status: "active", consecutiveFailures: 2 });
  });

  it("reviveSources clears a dead board and its streak, and makes it due now", async () => {
    for (let i = 0; i < 3; i++) await failed(T + 1000 + i, true);
    expect(await health()).toMatchObject({ status: "dead", consecutiveFailures: 3 });

    expect(await reviveSources(db, [source.id, "greenhouse:nope"])).toEqual([source.id]);
    expect(await health()).toMatchObject({ status: "active", consecutiveFailures: 0 });
    const [row] = await db.select().from(schema.sources).where(eq(schema.sources.id, source.id));
    expect(row?.nextDueAt).toBe(0);

    // The streak really restarted: one more 404 is not dead.
    await failed(T + 5000, true);
    expect(await health()).toMatchObject({ status: "active", consecutiveFailures: 1 });
  });

  it("a failure that is not a 404 leaves the streak alone, so it neither resets nor marks dead", async () => {
    await failed(T + 1000, true);
    await failed(T + 2000, true);
    await failed(T + 3000, false);
    expect(await health()).toMatchObject({ status: "active", consecutiveFailures: 2 });
    await failed(T + 4000, true);
    expect(await health()).toMatchObject({ status: "dead", consecutiveFailures: 3 });
  });

  it("only a successful listing resets the streak", async () => {
    await failed(T + 1000, true);
    await failed(T + 2000, true);
    const run = await start(T + 3000);
    await finalize(db, run, fin(["1"], { listingComplete: false }), T + 3000);
    expect(await health()).toMatchObject({ status: "active", consecutiveFailures: 2 });
    await failed(T + 4000, true);
    expect(await health()).toMatchObject({ status: "dead", consecutiveFailures: 3 });
  });

  it("interleaved failures do not stop consecutive 404s from marking a board dead", async () => {
    await failed(T + 1000, true);
    await failed(T + 2000, false);
    await failed(T + 3000, true);
    await failed(T + 4000, false);
    await failed(T + 5000, true);
    expect(await health()).toMatchObject({ status: "dead", consecutiveFailures: 3 });
  });

  it("a complete listing revives a dead board", async () => {
    for (let i = 1; i <= 3; i++) await failed(T + i * 1000, true);
    expect(await health()).toMatchObject({ status: "dead" });
    const run = await start(T + 4000);
    await finalize(db, run, fin([]), T + 4000);
    expect(await health()).toMatchObject({ status: "active", consecutiveFailures: 0 });
  });

  it("a complete run never counts as a 404 even if the flag is set", async () => {
    const run = await start(T + 1000);
    await finalize(db, run, fin([], { boardNotFound: true }), T + 1000);
    expect(await health()).toMatchObject({ status: "active", consecutiveFailures: 0 });
  });

  it("counts each run once: finalize is idempotent", async () => {
    const run = await start(T + 1000);
    await finalize(db, run, fin([], { listingComplete: false, boardNotFound: true }), T + 1000);
    await finalize(db, run, fin([], { listingComplete: false, boardNotFound: true }), T + 1000);
    expect(await health()).toMatchObject({ consecutiveFailures: 1 });
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

describe("stuck runs", () => {
  it("marks a run left running past the lease as partial, and closes nothing", async () => {
    const first = await start(T + 1000);
    await ingest(first, [mapped("1"), mapped("2")]);
    await finalize(db, first, fin(["1", "2"]), T + 1000);
    // The collector is killed after listing: the run never finalizes.
    const stuck = await start(T + 2000);
    expect(await reapStaleRuns(db, T + 2000 + 60)).toBe(0);
    expect(await reapStaleRuns(db, T + 2000 + 3 * 3600)).toBe(1);

    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, stuck));
    expect(row).toMatchObject({ status: "partial", closed: null });
    expect(row?.issues).toEqual([
      { code: "stopped", message: "Collector process stopped before finalize" },
    ]);
    const open = await db.select().from(schema.jobs);
    expect(open.map((j) => [j.closedAt, j.absentRuns])).toEqual([
      [null, 0],
      [null, 0],
    ]);
  });

  it("a late finalize from a reaped collector cannot close jobs", async () => {
    const first = await start(T + 1000);
    await ingest(first, [mapped("1")]);
    await finalize(db, first, fin(["1"]), T + 1000);
    const late = await start(T + 2000);
    await reapStaleRuns(db, T + 2000 + 3 * 3600);
    // The zombie collector reports an authoritatively empty listing after it was reaped.
    const result = await finalize(
      db,
      late,
      fin([], { emptyIsAuthoritative: true }),
      T + 2000 + 3 * 3600 + 1,
    );
    expect(result).toMatchObject({ status: "partial", closureApplied: false, closed: 0 });
    const open = await db.select().from(schema.jobs);
    expect(open.map((j) => j.closedAt)).toEqual([null]);
  });
});

describe("run retention", () => {
  const packRun = async (
    id: string,
    sourceId: string,
    startedAt: number,
    status: "complete" | "partial" | "running" = "complete",
  ) => {
    const key = rawKey(sourceId, id);
    await db.insert(schema.runs).values({
      id,
      sourceId,
      runnerId: "mac",
      collectorVersion: "t",
      startedAt,
      status,
      rawKey: key,
    });
    await blobs.put(key, new Uint8Array([1]));
    return key;
  };

  it("retains two packs per source, including partial runs, and prunes expired history", async () => {
    const day = 86400;
    const old = await packRun("a", "one", T - 40 * day);
    const second = await packRun("b", "one", T - 35 * day, "partial");
    const newest = await packRun("c", "one", T - day);
    const other = await packRun("d", "two", T - 40 * day);
    const active = await packRun("e", "one", T, "running");
    await packRun("abandoned", "one", T - 40 * day, "running");
    await db.insert(schema.runs).values({
      id: "expired",
      sourceId: "two",
      runnerId: "mac",
      collectorVersion: "t",
      startedAt: T - 31 * day,
      status: "running",
    });
    expect(await pruneRuns(db, blobs, T)).toEqual({ packs: 2, runs: 3 });
    expect(await blobs.has(old)).toBe(false);
    expect(blobs.keys().sort()).toEqual([second, newest, other, active].sort());
    expect((await db.select().from(schema.runs)).map((r) => r.id).sort()).toEqual([
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(await pruneRuns(db, blobs, T)).toEqual({ packs: 0, runs: 0 });
  });

  it("keeps recent history after pruning a pack and breaks timestamp ties by id", async () => {
    await packRun("a", "one", T);
    await packRun("b", "one", T);
    await packRun("c", "one", T);
    expect(await pruneRuns(db, blobs, T)).toEqual({ packs: 1, runs: 0 });
    const rows = await db.select().from(schema.runs);
    expect(rows.find((row) => row.id === "a")?.rawKey).toBeNull();
    expect(blobs.keys().sort()).toEqual([rawKey("one", "b"), rawKey("one", "c")]);
    expect(rows).toHaveLength(3);
  });

  it("drains a backlog over bounded invocations", async () => {
    for (let i = 0; i < 1003; i++) {
      await packRun(`run-${i}`, "one", T - 40 * 86400 + i);
    }
    expect(await pruneRuns(db, blobs, T)).toEqual({ packs: 1000, runs: 1000 });
    expect(await pruneRuns(db, blobs, T)).toEqual({ packs: 1, runs: 1 });
    expect(blobs.keys()).toHaveLength(2);
    expect(await db.select().from(schema.runs)).toHaveLength(2);
  });

  it("tracks interrupted raw uploads before finalization", async () => {
    await packRun("valid-a", source.id, T - 2);
    await packRun("valid-b", source.id, T - 1);
    const id = await start(T);
    await expect(
      storeRawPack(
        db,
        {
          ...blobs,
          put: async () => {
            throw new Error("upload failed");
          },
        },
        id,
        new Uint8Array([1]),
      ),
    ).rejects.toThrow("upload failed");
    expect((await db.select().from(schema.runs)).find((row) => row.id === id)).toMatchObject({
      rawKey: rawKey(source.id, id),
      rawUploaded: 0,
    });
    await finalize(db, id, fin([], { listingComplete: false }), T);
    expect(await pruneRuns(db, blobs, T)).toEqual({ packs: 0, runs: 0 });
    expect(await pruneRuns(db, blobs, T + 31 * 86400)).toEqual({ packs: 1, runs: 1 });
    expect(blobs.keys()).toHaveLength(2);
  });

  it("keeps a reference when blob deletion fails so cleanup can retry", async () => {
    await packRun("a", "one", T - 40 * 86400);
    await packRun("b", "one", T - 2);
    await packRun("c", "one", T - 1);
    await expect(
      pruneRuns(
        db,
        {
          ...blobs,
          delete: async () => {
            throw new Error("R2 unavailable");
          },
        },
        T,
      ),
    ).rejects.toThrow("R2 unavailable");
    expect((await db.select().from(schema.runs)).find((r) => r.id === "a")?.rawKey).toBe(
      rawKey("one", "a"),
    );
    expect(await pruneRuns(db, blobs, T)).toEqual({ packs: 1, runs: 1 });
  });
});
