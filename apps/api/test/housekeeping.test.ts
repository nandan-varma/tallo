import {
  type BlobStore,
  jdKey,
  memoryBlobs,
  purgeClosed,
  rebuildDuplicates,
  schema,
} from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  type Housekeeping,
  type HousekeepingEvent,
  housekeeping,
  MAX_REGROUP_PAGES,
  PURGE_JOBS_PER_RUN,
} from "../src/housekeeping.ts";

/** Fakes that succeed quietly; a test overrides the step it cares about. */
function fakes(over: Partial<Housekeeping> = {}): Housekeeping {
  return {
    reapStaleRuns: vi.fn(async () => 0),
    repairSchedule: vi.fn(async () => 0),
    purgeClosed: vi.fn(async () => 0),
    pruneRuns: vi.fn(async () => ({ packs: 0, runs: 0 })),
    regroupPage: vi.fn(async () => ({ next: null })),
    ...over,
  };
}

const run = (ops: Housekeeping) => {
  const events: HousekeepingEvent[] = [];
  return housekeeping(ops, (event) => events.push(event)).then(() => events);
};

describe("hourly housekeeping", () => {
  it("runs every step, in order, when all succeed", async () => {
    const order: string[] = [];
    const ops = fakes({
      reapStaleRuns: async () => void order.push("reap"),
      repairSchedule: async () => void order.push("repair"),
      purgeClosed: async () => {
        order.push("purge");
        return 0;
      },
      pruneRuns: async () => {
        order.push("prune");
        return { packs: 0, runs: 0 };
      },
      regroupPage: async () => {
        order.push("regroup");
        return { next: null };
      },
    });
    expect(await run(ops)).toEqual([]);
    expect(order).toEqual(["reap", "repair", "purge", "prune", "regroup"]);
  });

  it("a step that throws is reported, and every other step still runs", async () => {
    const ops = fakes({
      repairSchedule: async () => {
        throw new Error("D1 exploded");
      },
    });
    const events = await run(ops);
    expect(events).toEqual([{ step: "repairSchedule", outcome: "error", error: "D1 exploded" }]);
    expect(ops.reapStaleRuns).toHaveBeenCalledOnce();
    expect(ops.purgeClosed).toHaveBeenCalledOnce();
    expect(ops.pruneRuns).toHaveBeenCalledOnce();
    expect(ops.regroupPage).toHaveBeenCalledOnce();
  });

  it("a failing purge does not skip pruning or regrouping", async () => {
    const ops = fakes({
      purgeClosed: async () => {
        throw new Error("blob store down");
      },
    });
    const events = await run(ops);
    expect(events.map((e) => e.step)).toEqual(["purgeClosed"]);
    expect(ops.pruneRuns).toHaveBeenCalledOnce();
    expect(ops.regroupPage).toHaveBeenCalledOnce();
  });

  it("truncates a long error message", async () => {
    const ops = fakes({
      reapStaleRuns: async () => {
        throw new Error("x".repeat(1000));
      },
    });
    const [event] = await run(ops);
    expect(event?.error).toHaveLength(300);
  });

  it("purges one bounded batch per invocation, and reports a budget only when more may be waiting", async () => {
    const ops = fakes({ purgeClosed: vi.fn(async () => PURGE_JOBS_PER_RUN) });
    expect(await run(ops)).toEqual([{ step: "purgeClosed", outcome: "budget" }]);
    expect(ops.purgeClosed).toHaveBeenCalledOnce();
    expect(ops.purgeClosed).toHaveBeenCalledWith(PURGE_JOBS_PER_RUN);

    const short = fakes({ purgeClosed: vi.fn(async () => PURGE_JOBS_PER_RUN - 1) });
    expect(await run(short)).toEqual([]);
  });

  it("regroup starts by resuming (undefined cursor), then follows each returned cursor", async () => {
    const pages = [{ next: "k1" }, { next: "k2" }, { next: null }];
    const ops = fakes({ regroupPage: vi.fn(async () => pages.shift() ?? { next: null }) });
    expect(await run(ops)).toEqual([]);
    expect(vi.mocked(ops.regroupPage).mock.calls.map((c) => c[0])).toEqual([undefined, "k1", "k2"]);
  });

  it("bounds the regroup loop per invocation and reports that it stopped", async () => {
    const ops = fakes({ regroupPage: vi.fn(async () => ({ next: "more" })) });
    const events = await run(ops);
    expect(ops.regroupPage).toHaveBeenCalledTimes(MAX_REGROUP_PAGES);
    expect(events).toEqual([{ step: "regroup", outcome: "budget" }]);
  });

  it("a regroup error stops only regroup", async () => {
    const ops = fakes({
      regroupPage: async () => {
        throw new Error("boom");
      },
    });
    const events = await run(ops);
    expect(events).toEqual([{ step: "regroup", outcome: "error", error: "boom" }]);
  });
});

describe("hourly housekeeping against a database", () => {
  const NOW = 2_000_000_000;
  const HOUR = 3600;
  const DAY = 86400;

  /** Insert one job row. Duplicates share a `key`; closed rows are closed long ago. */
  async function job(
    db: ReturnType<typeof testDb>,
    n: number,
    fields: {
      key?: string | null;
      updatedAt?: number;
      closedAt?: number | null;
      dupOf?: number | null;
    },
  ): Promise<number> {
    const [inserted] = await db
      .insert(schema.jobs)
      .values({
        sourceId: "fresh",
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
        updatedAt: fields.updatedAt ?? NOW - HOUR,
        dedupeKey: fields.key ?? null,
        dupOf: fields.dupOf ?? null,
        closedAt: fields.closedAt ?? null,
      })
      .returning({ id: schema.jobs.id });
    return inserted?.id ?? 0;
  }

  async function freshSource(db: ReturnType<typeof testDb>) {
    await db.insert(schema.sources).values({
      id: "fresh",
      platform: "lever",
      key: "fresh",
      company: "Acme",
      companySlug: "acme",
      params: {},
      lastListedAt: NOW,
    });
  }

  it("purges at most PURGE_JOBS_PER_RUN jobs, and at most two blob calls per job, per invocation", async () => {
    const db = testDb();
    await freshSource(db);
    const inner = memoryBlobs();
    let calls = 0;
    const counted =
      <A extends unknown[], R>(f: (...args: A) => R) =>
      (...args: A): R => {
        calls++;
        return f(...args);
      };
    const blobs: BlobStore = {
      has: counted(inner.has),
      put: counted(inner.put),
      get: counted(inner.get),
      delete: counted(inner.delete),
    };
    const total = PURGE_JOBS_PER_RUN * 2 + 50;
    for (let n = 0; n < total; n++) {
      await job(db, n, { closedAt: NOW - 60 * DAY });
      await inner.put(jdKey(`h${n}`), new Uint8Array([n]));
    }
    const ops: Housekeeping = {
      reapStaleRuns: async () => 0,
      repairSchedule: async () => 0,
      purgeClosed: (limit) => purgeFromDb(db, blobs, limit, NOW),
      pruneRuns: async () => ({ packs: 0, runs: 0 }),
      regroupPage: async () => ({ next: null }),
    };

    calls = 0;
    await run(ops);
    // One get and one delete per purged job with an unreferenced blob; the bound is the per-invocation cap.
    expect(calls).toBeLessThanOrEqual(2 * PURGE_JOBS_PER_RUN);
    expect(await countJobs(db)).toBe(total - PURGE_JOBS_PER_RUN);

    // The next hours continue the backlog: 150, then the last 50, which is a short batch and reports nothing.
    await run(ops);
    expect(await countJobs(db)).toBe(total - 2 * PURGE_JOBS_PER_RUN);
    expect(await run(ops)).toEqual([]);
    expect(await countJobs(db)).toBe(0);
  });

  it("two budget-limited invocations together finish a regroup backlog", async () => {
    const db = testDb();
    await freshSource(db);
    // Six keys, each a canonical and a duplicate written with dup_of unset: the pass has to repair every one.
    const pairs: { canonical: number; duplicate: number }[] = [];
    for (let k = 0; k < 6; k++) {
      const canonical = await job(db, 100 + 2 * k, { key: `K-${k}` });
      const duplicate = await job(db, 101 + 2 * k, { key: `K-${k}` });
      pairs.push({ canonical, duplicate });
    }
    // Two candidates per page: the backlog outlasts one invocation's MAX_REGROUP_PAGES pages, and two invocations finish it.
    const ops: Housekeeping = {
      reapStaleRuns: async () => 0,
      repairSchedule: async () => 0,
      purgeClosed: async () => 0,
      pruneRuns: async () => ({ packs: 0, runs: 0 }),
      regroupPage: (after) => rebuildDuplicates(db, NOW, { limit: 3, after }),
    };

    const first = await run(ops);
    expect(first).toEqual([{ step: "regroup", outcome: "budget" }]);
    expect(await checkpoint(db)).toBeUndefined();
    expect(await progressRow(db)).toBeDefined();

    // The second invocation resumes the recorded cursor and completes the pass within its budget.
    expect(await run(ops)).toEqual([]);
    expect(await checkpoint(db)).toBe(NOW);
    expect(await progressRow(db)).toBeUndefined();
    for (const { canonical, duplicate } of pairs) {
      const [row] = await db
        .select({ dupOf: schema.jobs.dupOf })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, duplicate));
      expect(row?.dupOf).toBe(canonical);
    }
  });

  const checkpoint = async (db: ReturnType<typeof testDb>) =>
    (await db.select().from(schema.regroupState).where(eq(schema.regroupState.id, 1)))[0]
      ?.checkedAt;
  const progressRow = async (db: ReturnType<typeof testDb>) =>
    (await db.select().from(schema.regroupProgress).where(eq(schema.regroupProgress.id, 1)))[0];
  const countJobs = async (db: ReturnType<typeof testDb>) =>
    (await db.select().from(schema.jobs)).length;
  const purgeFromDb = (
    db: ReturnType<typeof testDb>,
    blobs: BlobStore,
    limit: number,
    now: number,
  ) => purgeClosed(db, blobs, 30, now, limit);
});
