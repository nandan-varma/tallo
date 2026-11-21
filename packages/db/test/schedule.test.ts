import type { SourceConfig } from "@tallo/contracts";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimDue,
  claimSources,
  collectStatus,
  deferBusy,
  finalize,
  registerSources,
  repairSchedule,
  reviveSources,
  schema,
  sourceConfig,
  startRun,
} from "../src/index.ts";
import { testDb } from "../src/testing.ts";

const T = 1_800_000_000;
const DAY = 86400;
const HOUR = 3600;
let db: ReturnType<typeof testDb>;

const config = (key: string, company = key): SourceConfig => ({
  id: `greenhouse:${key}`,
  platform: "greenhouse",
  key,
  company,
  params: {},
});

const dueOf = async (id: string) => {
  const [row] = await db
    .select({ nextDueAt: schema.sources.nextDueAt, tier: schema.sources.tier })
    .from(schema.sources)
    .where(eq(schema.sources.id, id));
  if (!row) throw new Error(`no source ${id}`);
  return row;
};

const rowOf = async (id: string) => {
  const [row] = await db.select().from(schema.sources).where(eq(schema.sources.id, id));
  if (!row) throw new Error(`no source ${id}`);
  return row;
};

async function startAndFinish(
  source: SourceConfig,
  runId: string,
  over: { listingComplete?: boolean; boardNotFound?: boolean; finishedAt?: number } = {},
) {
  await startRun(db, { runId, source, runnerId: "t", collectorVersion: "t", startedAt: T }, T);
  await finalize(
    db,
    runId,
    {
      seenIds: [],
      listingComplete: over.listingComplete ?? true,
      detailsComplete: true,
      emptyIsAuthoritative: true,
      requests: 1,
      finishedAt: over.finishedAt ?? T,
      rawKey: null,
      issues: [],
      boardNotFound: over.boardNotFound ?? false,
    },
    over.finishedAt ?? T,
  );
}

beforeEach(async () => {
  db = testDb();
  await registerSources(
    db,
    [config("a"), config("b"), config("c"), config("d", "Hot Co")],
    new Set(["greenhouse:d"]),
  );
});

describe("claimDue", () => {
  it("claims only boards whose due time has passed, most overdue first, up to the limit", async () => {
    // Everything registered is due now (0). Move two into the future.
    await db
      .update(schema.sources)
      .set({ nextDueAt: T + DAY })
      .where(eq(schema.sources.id, "greenhouse:c"));
    const claimed = await claimDue(db, T, 10);
    expect(claimed.map((s) => s.id).sort()).toEqual([
      "greenhouse:a",
      "greenhouse:b",
      "greenhouse:d",
    ]);
    // The claimed boards are leased, so the next claim finds nothing.
    expect(await claimDue(db, T, 10)).toEqual([]);
  });

  it("never hands the same board to two claimers, even with the limit split across calls", async () => {
    const first = await claimDue(db, T, 2);
    const second = await claimDue(db, T, 2);
    const ids = [...first, ...second].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  it("a lease expires: a board not finalized is due again after the lease window", async () => {
    await claimDue(db, T, 10);
    expect(await claimDue(db, T + 1799, 10)).toEqual([]);
    expect((await claimDue(db, T + 1800, 10)).length).toBe(4);
  });

  it("a limit below one claims nothing", async () => {
    expect(await claimDue(db, T, 0)).toEqual([]);
  });

  it("returns the config a collector needs", async () => {
    const [hot] = (await claimDue(db, T, 10)).filter((s) => s.id === "greenhouse:d");
    expect(hot).toMatchObject({ platform: "greenhouse", key: "d", company: "Hot Co", params: {} });
  });
});

describe("claimSources", () => {
  it("claims named boards regardless of due time, and leases them", async () => {
    await db
      .update(schema.sources)
      .set({ nextDueAt: T + DAY })
      .where(eq(schema.sources.id, "greenhouse:a"));
    const claimed = await claimSources(db, ["greenhouse:a"], T);
    expect(claimed.map((s) => s.id)).toEqual(["greenhouse:a"]);
    expect(await claimDue(db, T, 10)).not.toContainEqual(
      expect.objectContaining({ id: "greenhouse:a" }),
    );
  });
});

describe("local egress", () => {
  // A board the Mac must collect: the cloud's egress is refused (`params.egress: "local"`).
  const local = { ...config("e"), params: { egress: "local" } };
  beforeEach(async () => {
    await registerSources(db, [local], new Set());
  });

  it("the cloud claim never takes such a board, and its due time is left alone", async () => {
    const claimed = (await claimDue(db, T, 10)).map((s) => s.id);
    expect(claimed.sort()).toEqual([
      "greenhouse:a",
      "greenhouse:b",
      "greenhouse:c",
      "greenhouse:d",
    ]);
    expect(await dueOf(local.id)).toEqual({ nextDueAt: 0, tier: "normal" });
  });

  it("a named collect does not claim it either", async () => {
    expect(await claimSources(db, [local.id], T)).toEqual([]);
    expect((await dueOf(local.id)).nextDueAt).toBe(0);
  });

  it("is left out of the due count the status reports", async () => {
    const status = await collectStatus(db, T);
    expect(status.dueNow).toContainEqual({ tier: "normal", platform: "greenhouse", count: 3 });
  });
});

describe("registerSources", () => {
  it("a new board is due now with the tier its hot-list membership gives", async () => {
    expect(await dueOf("greenhouse:a")).toEqual({ nextDueAt: 0, tier: "normal" });
    expect(await dueOf("greenhouse:d")).toEqual({ nextDueAt: 0, tier: "hot" });
  });

  it("re-registering keeps an existing board's schedule", async () => {
    await db
      .update(schema.sources)
      .set({ nextDueAt: T + 5 * DAY })
      .where(eq(schema.sources.id, "greenhouse:b"));
    await registerSources(db, [config("b")], new Set());
    expect((await dueOf("greenhouse:b")).nextDueAt).toBe(T + 5 * DAY);
  });

  it("a board that becomes hot is due now; one that leaves the list becomes normal", async () => {
    await db
      .update(schema.sources)
      .set({ nextDueAt: T + 5 * DAY })
      .where(eq(schema.sources.id, "greenhouse:a"));
    await registerSources(db, [config("a")], new Set(["greenhouse:a"]));
    expect(await dueOf("greenhouse:a")).toEqual({ nextDueAt: 0, tier: "hot" });
    await registerSources(db, [config("a")], new Set());
    expect(await dueOf("greenhouse:a")).toEqual({ nextDueAt: 0, tier: "normal" });
  });

  it("registers a large config in batches", async () => {
    const many = Array.from({ length: 250 }, (_, i) => config(`bulk${i}`));
    const { registered } = await registerSources(db, many, new Set());
    expect(registered).toBe(250);
    expect(await sourceConfig(db, "greenhouse:bulk249")).toMatchObject({ key: "bulk249" });
  });
});

describe("finalize sets the next due time", () => {
  it("a complete run is due again after its tier's interval", async () => {
    await startAndFinish(config("a"), "run-a-0000001", { finishedAt: T });
    expect((await dueOf("greenhouse:a")).nextDueAt).toBe(T + 7 * DAY);
    await startAndFinish(config("d", "Hot Co"), "run-d-0000001", { finishedAt: T });
    expect((await dueOf("greenhouse:d")).nextDueAt).toBe(T + DAY);
  });

  it("a partial run is retried in an hour, not a week later", async () => {
    await startAndFinish(config("a"), "run-a-0000002", { listingComplete: false, finishedAt: T });
    expect((await dueOf("greenhouse:a")).nextDueAt).toBe(T + HOUR);
    expect((await rowOf("greenhouse:a")).failureCount).toBe(1);
  });

  it("failures in a row back off 1h, 3h, 6h, then 24h", async () => {
    const dues: number[] = [];
    for (let i = 0; i < 5; i++) {
      await startAndFinish(config("a"), `run-a-bo${i}`, {
        listingComplete: false,
        finishedAt: T + i,
      });
      dues.push((await dueOf("greenhouse:a")).nextDueAt - (T + i));
    }
    expect(dues).toEqual([HOUR, 3 * HOUR, 6 * HOUR, 24 * HOUR, 24 * HOUR]);
    expect((await rowOf("greenhouse:a")).failureCount).toBe(5);
  });

  it("a complete run resets the failure count and returns to the tier interval", async () => {
    await startAndFinish(config("a"), "run-a-rs0001", { listingComplete: false, finishedAt: T });
    await startAndFinish(config("a"), "run-a-rs0002", { listingComplete: false, finishedAt: T });
    await startAndFinish(config("a"), "run-a-rs0003", { finishedAt: T });
    expect(await rowOf("greenhouse:a")).toMatchObject({ failureCount: 0, status: "active" });
    expect((await dueOf("greenhouse:a")).nextDueAt).toBe(T + 7 * DAY);
  });

  it("a board that never listed anything is checked every 30 days after ten failures, and stays active", async () => {
    for (let i = 0; i < 10; i++) {
      await startAndFinish(config("a"), `run-a-nv${String(i).padStart(2, "0")}`, {
        listingComplete: false,
        finishedAt: T + i,
      });
    }
    const row = await rowOf("greenhouse:a");
    expect(row).toMatchObject({ status: "active", failureCount: 10 });
    expect(row.nextDueAt).toBe(T + 9 + 30 * DAY);
  });

  it("a board that listed before keeps the 24-hour cap after ten failures", async () => {
    await db
      .update(schema.sources)
      .set({ lastListedAt: T - DAY })
      .where(eq(schema.sources.id, "greenhouse:a"));
    for (let i = 0; i < 10; i++) {
      await startAndFinish(config("a"), `run-a-lb${String(i).padStart(2, "0")}`, {
        listingComplete: false,
        finishedAt: T + i,
      });
    }
    expect((await dueOf("greenhouse:a")).nextDueAt).toBe(T + 9 + 24 * HOUR);
  });

  it("three 404 runs in a row mark the board dead and due in thirty days", async () => {
    for (let i = 0; i < 3; i++) {
      await startAndFinish(config("b"), `run-b-000000${i}`, {
        listingComplete: false,
        boardNotFound: true,
        finishedAt: T + i,
      });
    }
    const [row] = await db
      .select({ status: schema.sources.status })
      .from(schema.sources)
      .where(eq(schema.sources.id, "greenhouse:b"));
    expect(row?.status).toBe("dead");
    expect((await dueOf("greenhouse:b")).nextDueAt).toBe(T + 2 + 30 * DAY);
  });
});

describe("deferBusy", () => {
  it("a busy board that is due now moves to fifteen minutes from now", async () => {
    await deferBusy(db, "greenhouse:a", T);
    expect((await dueOf("greenhouse:a")).nextDueAt).toBe(T + 15 * 60);
  });

  it("keeps a later schedule: a lease or a finalize's due time is never moved earlier", async () => {
    await db
      .update(schema.sources)
      .set({ nextDueAt: T + 7 * DAY })
      .where(eq(schema.sources.id, "greenhouse:a"));
    await deferBusy(db, "greenhouse:a", T);
    expect((await dueOf("greenhouse:a")).nextDueAt).toBe(T + 7 * DAY);
  });

  it("is not a failure: the failure count does not move", async () => {
    await deferBusy(db, "greenhouse:a", T);
    expect((await rowOf("greenhouse:a")).failureCount).toBe(0);
  });
});

describe("repairSchedule", () => {
  it("brings an active board scheduled beyond the longest interval back to due now", async () => {
    await db
      .update(schema.sources)
      .set({ nextDueAt: T + 40 * DAY })
      .where(eq(schema.sources.id, "greenhouse:a"));
    expect(await repairSchedule(db, T)).toBe(1);
    expect((await dueOf("greenhouse:a")).nextDueAt).toBe(T);
  });

  it("leaves every legitimate schedule alone, including a dead board's thirty days", async () => {
    await db
      .update(schema.sources)
      .set({ nextDueAt: T + 30 * DAY, status: "active" })
      .where(eq(schema.sources.id, "greenhouse:a"));
    await db
      .update(schema.sources)
      .set({ nextDueAt: T + 40 * DAY, status: "dead" })
      .where(eq(schema.sources.id, "greenhouse:b"));
    await db
      .update(schema.sources)
      .set({ nextDueAt: T + 7 * DAY })
      .where(eq(schema.sources.id, "greenhouse:c"));
    expect(await repairSchedule(db, T)).toBe(0);
    expect((await dueOf("greenhouse:a")).nextDueAt).toBe(T + 30 * DAY);
    expect((await dueOf("greenhouse:b")).nextDueAt).toBe(T + 40 * DAY);
    expect((await dueOf("greenhouse:c")).nextDueAt).toBe(T + 7 * DAY);
  });
});

describe("reviveSources", () => {
  it("a revived board starts its back-off from scratch", async () => {
    await db
      .update(schema.sources)
      .set({ failureCount: 6, status: "dead" })
      .where(eq(schema.sources.id, "greenhouse:a"));
    await reviveSources(db, ["greenhouse:a"]);
    expect(await rowOf("greenhouse:a")).toMatchObject({ failureCount: 0, status: "active" });
  });
});

describe("collectStatus", () => {
  it("counts what is due by tier and platform, and the runs in flight", async () => {
    await startRun(
      db,
      {
        runId: "run-status-0001",
        source: config("c"),
        runnerId: "t",
        collectorVersion: "t",
        startedAt: T,
      },
      T,
    );
    const status = await collectStatus(db, T);
    expect(status.dueNow).toEqual(
      expect.arrayContaining([
        { tier: "normal", platform: "greenhouse", count: 3 },
        { tier: "hot", platform: "greenhouse", count: 1 },
      ]),
    );
    expect(status.inFlight).toEqual([
      expect.objectContaining({ runId: "run-status-0001", ageSeconds: 0 }),
    ]);
    expect(status.last24h).toEqual({ running: 1 });
  });
});
