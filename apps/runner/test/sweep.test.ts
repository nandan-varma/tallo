import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Outcome } from "@tallo/collect";
import type { SourceConfig } from "@tallo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { estimateCost, guardedFetch, planSweep } from "../src/sweep/board.ts";
import { classifyError, classifyOutcome } from "../src/sweep/classify.ts";
import { type RunBoard, Sweep, sweepPaths, type Timing } from "../src/sweep/controller.ts";
import { Lane, TUNING, type Tuning } from "../src/sweep/lane.ts";
import { formatStatus, setControl } from "../src/sweep/report.ts";
import { type LaneDef, readEdits } from "../src/sweep/settings.ts";

const board = (platform: string, key: string): SourceConfig => ({
  id: `${platform}:${key}`,
  platform,
  key,
  company: key,
  params: {},
});
const def = (name: string, concurrency: number, gapMs = 0): LaneDef => ({
  name,
  platforms: [name],
  settings: { concurrency, ceiling: concurrency, perHost: 2, gapMs, paused: false, enabled: true },
});
const outcome = (over: Partial<Outcome> = {}): Outcome =>
  ({
    seenIds: [],
    listingComplete: true,
    detailsComplete: true,
    emptyIsAuthoritative: false,
    requests: 1,
    finishedAt: 0,
    rawKey: null,
    issues: [],
    boardNotFound: false,
    notModified: false,
    changed: 0,
    ...over,
  }) as Outcome;
const ok = { outcome: outcome(), cost: { rows: 10, r2Puts: 1 } };
const fast: Timing = {
  tickMs: 5,
  controlMs: 20,
  statusMs: 40,
  pressurePauseMs: 20,
  recoverMs: 50,
  latencySpikeMs: 15_000,
};
const tuning: Tuning = { ...TUNING, deferBaseMs: 40, deferCapMs: 200, decreaseWindowMs: 10 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
}

let dir = "";
function setup(
  lanes: LaneDef[],
  boards: Record<string, string[]>,
  runBoard: RunBoard,
  extra: { tuning?: Tuning } = {},
) {
  dir = mkdtempSync(join(tmpdir(), "sweep-"));
  const paths = sweepPaths(dir);
  const work = new Map(
    Object.entries(boards).map(([lane, keys]) => [lane, keys.map((k) => board(lane, k))]),
  );
  const sweep = new Sweep({
    lanes,
    work,
    runBoard,
    paths,
    tuning: extra.tuning ?? tuning,
    timing: fast,
    random: () => 0.5,
  });
  const control = (value: unknown) => writeFileSync(paths.control, JSON.stringify(value));
  return { sweep, paths, control, lane: (n: string) => sweep.lanes.find((l) => l.name === n)! };
}
afterEach(() => {
  dir = "";
});

describe("AIMD", () => {
  const lane = (concurrency: number) => {
    const events: string[] = [];
    return { events, lane: new Lane(def("ashby", concurrency), [], tuning, (m) => events.push(m)) };
  };

  it("halves concurrency and backs the gap off on a 429, once per burst", () => {
    const { lane: l, events } = lane(4);
    l.on429(undefined, 1000);
    l.on429(undefined, 1001);
    l.on429(undefined, 1002);
    expect(l.settings.concurrency).toBe(2);
    expect(l.settings.gapMs).toBe(8000);
    expect(l.r429).toBe(3);
    expect(events).toHaveLength(1);
    l.on429(undefined, 5000);
    expect(l.settings.concurrency).toBe(1);
    expect(l.settings.gapMs).toBe(16000);
    l.on429(undefined, 9000);
    expect(l.settings.concurrency).toBe(1);
  });

  it("starts at a short gap when the host sends Retry-After, and holds the lane for it", () => {
    const { lane: l } = lane(3);
    l.on429(30_000, 1000);
    expect(l.settings.gapMs).toBe(500);
    expect(l.cooldownUntil).toBe(31_000);
  });

  it("recovers: after clean boards concurrency rises to the ceiling and the gap shrinks", () => {
    const { lane: l } = lane(4);
    l.on429(undefined, 1000);
    expect(l.settings.concurrency).toBe(2);
    for (let i = 0; i < 5; i++) l.onClean();
    expect(l.settings.concurrency).toBe(3);
    expect(l.settings.gapMs).toBe(4000);
    for (let i = 0; i < 50; i++) l.onClean();
    expect(l.settings.concurrency).toBe(4);
    expect(l.settings.gapMs).toBe(0);
  });

  it("learns the sustainable gap: it does not shrink back into a gap that 429ed", () => {
    const { lane: l } = lane(1);
    l.on429(undefined, 1000); // 0 -> 8000
    l.on429(undefined, 20_000); // 429 at 8000 -> 16000
    for (let i = 0; i < 100; i++) l.onClean();
    expect(l.settings.gapMs).toBe(10_000);
  });
});

describe("per-host 429", () => {
  const multi = (concurrency: number): LaneDef => ({
    ...def("workday", concurrency),
    multiHost: true,
  });
  const mk = (d: LaneDef) => {
    const events: string[] = [];
    const lane = new Lane(d, [], tuning, (m) => events.push(m));
    return { events, lane };
  };
  const A = "dollartree.wd5.myworkdayjobs.com";
  const B = "acme.wd1.myworkdayjobs.com";

  it("slows only the host that said 429, and names it", () => {
    const { lane, events } = mk(multi(6));
    lane.on429(undefined, 1000, A);
    expect(lane.settings.concurrency).toBe(6);
    expect(lane.settings.gapMs).toBe(0);
    expect(lane.hostSlowdown()).toEqual({ slowed: 1, worstGapMs: 2000 });
    expect(events).toEqual([`workday: ${A} 429, host gap 0 -> 2000 ms`]);
    lane.on429(undefined, 20_000, A);
    expect(lane.hostSlowdown().worstGapMs).toBe(4000);
  });

  it("honors Retry-After for the host gap, without holding the lane", () => {
    const { lane } = mk(multi(6));
    lane.on429(30_000, 1000, A);
    expect(lane.hostSlowdown().worstGapMs).toBe(30_000);
    expect(lane.cooldownUntil).toBe(0);
  });

  it("reduces the lane only when two hosts say 429 within 60 s", () => {
    const { lane } = mk(multi(6));
    lane.on429(undefined, 1000, A);
    lane.on429(undefined, 100_000, B); // A's 429 is too old
    expect(lane.settings.concurrency).toBe(6);
    lane.on429(undefined, 110_000, A);
    expect(lane.settings.concurrency).toBe(3);
    expect(lane.settings.gapMs).toBe(0);
  });

  it("decays a host gap after clean requests", () => {
    const { lane } = mk(multi(6));
    lane.on429(undefined, 1000, A);
    for (let i = 0; i < 10; i++) lane.observe(200, undefined, 2000, A);
    expect(lane.hostSlowdown().worstGapMs).toBe(1000);
    for (let i = 0; i < 30; i++) lane.observe(200, undefined, 3000, A);
    expect(lane.hostSlowdown()).toEqual({ slowed: 0, worstGapMs: 0 });
  });

  it("a single-host lane keeps the lane-wide behavior", () => {
    const { lane } = mk(def("greenhouse", 4));
    lane.observe(429, undefined, 1000, "boards-api.greenhouse.io");
    expect(lane.settings.concurrency).toBe(2);
    expect(lane.settings.gapMs).toBe(8000);
    expect(lane.hostSlowdown().slowed).toBe(0);
  });
});

describe("409 busy", () => {
  const busy = () =>
    Object.assign(new Error("Conflict"), { response: { status: 409, headers: new Headers() } });
  const busyTuning: Tuning = {
    ...tuning,
    busyBaseMs: 10,
    busyCapMs: 40,
    busyMaxMs: 400,
    maxAttempts: 2,
  };

  it("retries past maxAttempts and logs once", async () => {
    let calls = 0;
    const t = setup(
      [def("a", 1)],
      { a: ["x"] },
      async () => {
        if (++calls <= 5) throw busy();
        return ok;
      },
      { tuning: busyTuning },
    );
    await t.sweep.run();
    expect(calls).toBe(6);
    expect(t.lane("a").done).toBe(1);
    expect(t.lane("a").stuck).toBe(0);
    const log = readFileSync(t.paths.events, "utf8");
    expect(log.match(/held by another run, will retry until it ages out/g)).toHaveLength(1);
    expect(log).not.toMatch(/deferred/);
  });

  it("marks the board stuck once it has been held past the limit", async () => {
    const t = setup(
      [def("a", 1)],
      { a: ["x"] },
      async () => {
        throw busy();
      },
      { tuning: { ...busyTuning, busyMaxMs: 120 } },
    );
    await t.sweep.run();
    expect(t.lane("a").stuck).toBe(1);
    expect(readFileSync(t.paths.events, "utf8")).toMatch(/held by another run for over 2 h/);
  });

  it("backs off from 2 min to a 15 min cap, jittered", () => {
    const l = new Lane(def("a", 1), [], TUNING, () => {});
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 9].map((n) => l.busyDelay(n, mid) / 60_000)).toEqual([
      2, 4, 8, 15, 15, 15,
    ]);
    expect(l.busyDelay(1, () => 0)).toBe(90_000);
  });
});

describe("sweep", () => {
  it("defers a retryable failure with backoff without blocking the lane", async () => {
    const order: string[] = [];
    let failed = false;
    const t = setup([def("a", 1)], { a: ["x", "y", "z"] }, async (source) => {
      order.push(source.key);
      if (source.key === "x" && !failed) {
        failed = true;
        throw Object.assign(new Error("Database busy"), {
          response: { status: 503, headers: new Headers() },
        });
      }
      return ok;
    });
    expect(await t.sweep.run()).toBe("finished");
    expect(order).toEqual(["x", "y", "z", "x"]);
    expect(t.lane("a").done).toBe(3);
    expect(readFileSync(t.paths.events, "utf8")).toMatch(/a: x deferred .*HTTP 503/);
  });

  it("marks a board stuck after the maximum attempts, with the reason", async () => {
    let calls = 0;
    const t = setup([def("a", 1)], { a: ["x"] }, async () => {
      calls++;
      throw new TypeError("fetch failed");
    });
    await t.sweep.run();
    expect(calls).toBe(4);
    expect(t.lane("a").stuck).toBe(1);
    expect(t.lane("a").errors[0]).toMatch(/x: fetch failed/);
  });

  it("does not retry a permanent failure", async () => {
    let calls = 0;
    const t = setup([def("a", 1)], { a: ["gone", "fine"] }, async (source) => {
      calls++;
      return source.key === "gone"
        ? {
            outcome: outcome({ listingComplete: false, boardNotFound: true }),
            cost: { rows: 8, r2Puts: 0 },
          }
        : ok;
    });
    await t.sweep.run();
    expect(calls).toBe(2);
    expect(t.lane("a").failedPermanent).toBe(1);
    expect(t.lane("a").done).toBe(1);
  });

  it("changes lane concurrency while it runs when the control file is edited", async () => {
    let live = 0;
    let peak = 0;
    const t = setup(
      [def("a", 1)],
      { a: Array.from({ length: 30 }, (_, i) => `b${i}`) },
      async () => {
        peak = Math.max(peak, ++live);
        await sleep(30);
        live--;
        return ok;
      },
    );
    const done = t.sweep.run();
    await sleep(60);
    expect(peak).toBe(1);
    t.control({ lanes: { a: { concurrency: 3 } } });
    await until(() => peak === 3);
    expect(t.lane("a").settings.concurrency).toBe(3);
    await done;
  });

  it("pauses and resumes a lane from the control file", async () => {
    let started = 0;
    const t = setup(
      [def("a", 1), def("b", 1)],
      { a: ["1", "2", "3", "4", "5", "6"], b: ["1"] },
      async () => {
        started++;
        await sleep(15);
        return ok;
      },
    );
    t.control({ lanes: { a: { paused: true } } });
    const done = t.sweep.run();
    await until(() => t.lane("b").done === 1);
    await sleep(80);
    expect(t.lane("a").done).toBe(0);
    expect(t.lane("a").inFlight.size).toBe(0);
    t.control({ lanes: { a: { paused: false } } });
    expect(await done).toBe("finished");
    expect(t.lane("a").done).toBe(6);
    expect(started).toBe(7);
  });

  it("drains on stop: in-flight boards finish, nothing new starts", async () => {
    let started = 0;
    let finished = 0;
    const t = setup(
      [def("a", 3)],
      { a: Array.from({ length: 20 }, (_, i) => `b${i}`) },
      async () => {
        started++;
        await sleep(100);
        finished++;
        return ok;
      },
    );
    const done = t.sweep.run();
    await until(() => started === 3);
    t.control({ global: { stop: true } });
    expect(await done).toBe("stopped");
    expect(started).toBe(3);
    expect(finished).toBe(3);
    expect(JSON.parse(readFileSync(t.paths.status, "utf8")).state).toBe("stopped");
  });

  it("pauses every lane at the budget and resumes when it is raised", async () => {
    let started = 0;
    const t = setup([def("a", 1)], { a: ["1", "2", "3", "4", "5", "6"] }, async () => {
      started++;
      return { outcome: outcome(), cost: { rows: 600, r2Puts: 2 } };
    });
    t.control({ budget: { maxRowsWritten: 1000 } });
    const done = t.sweep.run();
    await until(() => started === 2);
    await sleep(100);
    expect(started).toBe(2);
    const status = t.sweep.status();
    expect(status.cost.budgetHeld).toBe(true);
    expect(status.cost.rowsWritten).toBe(1200);
    expect(status.lanes.a?.state).toBe("budget-hold");
    expect(readFileSync(t.paths.events, "utf8")).toMatch(/budget reached/);
    t.control({ budget: { maxRowsWritten: 100_000 } });
    await done;
    expect(started).toBe(6);
  });

  it("ignores invalid control edits with an event and keeps running", async () => {
    const t = setup([def("a", 1)], { a: ["1", "2"] }, async () => {
      await sleep(30);
      return ok;
    });
    t.control({
      lanes: { a: { concurrency: "lots", gapMs: -5 }, nope: { paused: true } },
      global: { maxInFlight: 0 },
    });
    expect(await t.sweep.run()).toBe("finished");
    const events = readFileSync(t.paths.events, "utf8");
    expect(events).toMatch(/control ignored: lanes\.a\.concurrency/);
    expect(events).toMatch(/unknown lane/);
    expect(t.lane("a").settings.concurrency).toBe(1);
  });

  it("shrinks in-flight capacity and pauses starts when ingest answers 503", async () => {
    const t = setup([def("a", 1)], { a: ["1"] }, async () => ok);
    t.sweep.observeApi(503, 10, 40);
    const status = t.sweep.status();
    expect(status.global.capacity).toBe(15);
    expect(status.global.startsPausedUntil).not.toBeNull();
    await t.sweep.run();
    expect(t.lane("a").done).toBe(1);
  });

  it("writes a status table with per-lane numbers", async () => {
    const t = setup([def("a", 1)], { a: ["1", "2"] }, async () => ok);
    await t.sweep.run();
    const status = JSON.parse(readFileSync(t.paths.status, "utf8"));
    expect(status.lanes.a).toMatchObject({ due: 2, done: 2, deferred: 0 });
    const text = formatStatus(status, t.sweep.events.slice(-3));
    expect(text).toMatch(/lane\s+state/);
    expect(text).toMatch(/a\s+done/);
  });
});

describe("work order", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const configured = [
    board("greenhouse", "old"),
    board("greenhouse", "never"),
    board("greenhouse", "fresh"),
    board("lever", "l1"),
    board("workday", "w1"),
  ];
  const state = (last: Record<string, number>) =>
    new Map(
      Object.entries(last).map(([id, lastCompleteRunAt]) => [
        id,
        {
          id,
          company: id,
          status: "active" as const,
          consecutiveFailures: 0,
          lastRunAt: null,
          lastCompleteRunAt,
        },
      ]),
    );
  const lanes = [def("greenhouse", 1), def("lever", 1)].map((l) => l);

  it("partitions by lane, never-synced first then oldest, and drops fresh boards", () => {
    const s = state({
      "greenhouse:old": now / 1000 - 90 * 3600,
      "greenhouse:fresh": now / 1000 - 3600,
    });
    const work = planSweep(configured, s as never, lanes, { staleHours: 20, now });
    expect(work.get("greenhouse")?.map((b) => b.key)).toEqual(["never", "old"]);
    expect(work.get("lever")?.map((b) => b.key)).toEqual(["l1"]);
    expect(work.has("workday")).toBe(false);
  });

  it("is a fixed list: the horizon is the start time, later state changes do not matter", () => {
    const s = state({ "greenhouse:old": now / 1000 - 90 * 3600 });
    const work = planSweep(configured, s as never, lanes, { staleHours: 20, now });
    // The board completes after the sweep started, another ages out: neither changes the plan.
    s.set("greenhouse:old", { ...s.get("greenhouse:old")!, lastCompleteRunAt: now / 1000 + 5 });
    expect(work.get("greenhouse")?.map((b) => b.key)).toContain("old");
    expect(work.get("greenhouse")).toHaveLength(3);
  });
});

describe("settings and classification", () => {
  it("setControl validates, stamps and merges", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ctl-")), "control.json");
    setControl(path, ["ashby"], "ashby", ["concurrency=2", "gapMs=500"], 1);
    setControl(path, ["ashby"], "global", ["maxInFlight=20"], 2);
    expect(() => setControl(path, ["ashby"], "ashby", ["concurrency=0"])).toThrow(/concurrency/);
    expect(() => setControl(path, ["ashby"], "nope", ["paused=true"])).toThrow(/Unknown lane/);
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.lanes.ashby).toEqual({ concurrency: 2, gapMs: 500 });
    expect(file.global).toEqual({ maxInFlight: 20 });
    expect(file._stamps["lanes.ashby.gapMs"]).toBe(1);
    expect(readEdits(file, ["ashby"]).errors).toEqual([]);
  });

  it("classifies errors and outcomes", () => {
    const http = (status: number) =>
      Object.assign(new Error("x"), {
        response: { status, headers: new Headers({ "retry-after": "7" }) },
      });
    expect(classifyError(http(503))).toMatchObject({ kind: "retryable", retryAfterMs: 7000 });
    expect(classifyError(http(409))).toMatchObject({ kind: "retryable", reason: "409 busy" });
    expect(classifyError(http(422)).kind).toBe("permanent");
    expect(classifyError(new TypeError("fetch failed")).kind).toBe("retryable");
    expect(classifyError(new Error("invalid shape")).kind).toBe("permanent");
    expect(classifyOutcome(outcome()).kind).toBe("ok");
    expect(classifyOutcome(outcome({ listingComplete: false, boardNotFound: true })).kind).toBe(
      "permanent",
    );
    expect(
      classifyOutcome(
        outcome({
          listingComplete: false,
          issues: [{ code: "http", message: "Request failed with status code 429" }],
        }),
      ).kind,
    ).toBe("retryable");
    expect(
      classifyOutcome(
        outcome({ listingComplete: false, issues: [{ code: "schema", message: "bad json" }] }),
      ).kind,
    ).toBe("permanent");
  });

  it("estimates cost from the run result", () => {
    expect(
      estimateCost({ applied: 10, closed: 2, descriptions: 10, rawPacks: 1, firstRun: true }),
    ).toEqual({ rows: 8 + 200 + 10, r2Puts: 11 });
    expect(
      estimateCost({ applied: 10, closed: 0, descriptions: 3, rawPacks: 1, firstRun: false }).rows,
    ).toBe(38);
  });
});

describe("guardedFetch", () => {
  it("passes responses through before the sweep exists (planning reads the source list first)", async () => {
    const fetchIt = guardedFetch(
      async () => new Response("ok", { status: 200 }),
      () => undefined,
    );
    expect((await fetchIt("https://api.test/v1/sources")).status).toBe(200);
  });

  it("reports status and latency to the sweep once it exists", async () => {
    const seen: number[] = [];
    const fetchIt = guardedFetch(
      async () => new Response("busy", { status: 503 }),
      () => ({ observeApi: (status: number) => seen.push(status) }) as unknown as Sweep,
    );
    await fetchIt("https://api.test/v1/runs");
    expect(seen).toEqual([503]);
  });
});
