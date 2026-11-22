import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Outcome, Timings } from "@tallo/collect";
import type { SourceConfig } from "@tallo/contracts";
import { createHostLimiter, podKey } from "@tallo/http";
import { afterEach, describe, expect, it } from "vitest";
import { estimateCost, guardedFetch, planSweep } from "../src/sweep/board.ts";
import { classifyError, classifyOutcome } from "../src/sweep/classify.ts";
import { type RunBoard, Sweep, sweepPaths, type Timing } from "../src/sweep/controller.ts";
import { boardGroup, Lane, TUNING, type Tuning } from "../src/sweep/lane.ts";
import { formatStatus, setControl } from "../src/sweep/report.ts";
import { type LaneDef, readEdits } from "../src/sweep/settings.ts";
import { bottleneckMessage, LaneTimings, sharesLine } from "../src/sweep/timing.ts";

const board = (platform: string, key: string): SourceConfig => ({
  id: `${platform}:${key}`,
  platform,
  key,
  company: key,
  params: {},
});
const def = (name: string, concurrency: number, gapMs = 0, floorMs?: number): LaneDef => ({
  name,
  platforms: [name],
  settings: {
    concurrency,
    ceiling: concurrency,
    perHost: 2,
    perHostCeiling: 4,
    gapMs,
    ...(floorMs === undefined ? {} : { floorMs }),
    paused: false,
    enabled: true,
  },
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
  bottleneckMs: 60,
  learnedSaveMs: 30,
  learnedMaxAgeMs: 7 * 24 * 3_600_000,
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

  it("probes below the configured gap when the lane says how far, and stops at that floor", () => {
    const events: string[] = [];
    const l = new Lane(def("walmart", 1, 700, 250), [], tuning, (m) => events.push(m));
    for (let i = 0; i < 5; i++) l.onClean();
    expect(l.settings.gapMs).toBe(350);
    for (let i = 0; i < 50; i++) l.onClean();
    expect(l.settings.gapMs).toBe(250);
    expect(events.at(-1)).toBe("walmart: 5 clean boards, concurrency 1 -> 1, gap 350 -> 250 ms");
  });

  it("probes the gap on clean requests, without waiting for a whole board to finish", () => {
    const events: string[] = [];
    const d = def("walmart", 1, 700, 250);
    d.settings.perHost = 8;
    d.settings.perHostCeiling = 8;
    const l = new Lane(d, [], tuning, (m) => events.push(m));
    for (let i = 0; i < 150; i++) l.observe(200, undefined, i, "careers.walmart.com");
    expect(l.settings.gapMs).toBe(350);
    for (let i = 0; i < 150; i++) l.observe(200, undefined, 1000 + i, "careers.walmart.com");
    expect(l.settings.gapMs).toBe(250);
    expect(events).toContain("walmart: 150 clean requests, gap 700 -> 350 ms (floor 250)");
  });

  it("keeps the configured gap as the floor when no floor is given", () => {
    const l = new Lane(def("microsoft", 1, 1000), [], tuning, () => {});
    for (let i = 0; i < 50; i++) l.onClean();
    expect(l.settings.gapMs).toBe(1000);
  });

  it("forgets a bad gap after a quiet half hour, so a bad minute does not cost the sweep", () => {
    const events: string[] = [];
    const l = new Lane(def("workday", 1, 250, 100), [], tuning, (m) => events.push(m));
    l.on429(undefined, 1000);
    expect(l.settings.gapMs).toBe(8000);
    for (let i = 0; i < 50; i++) l.onClean();
    expect(l.settings.gapMs).toBe(313); // 1.25 x the 250 ms gap that 429ed, above the 100 ms floor
    for (let i = 0; i < 200; i++) l.onClean(1000 + 31 * 60_000);
    expect(l.settings.gapMs).toBeLessThanOrEqual(157); // the margin decayed with the bad gap
  });

  it("learns the sustainable gap: it does not shrink back into a gap that 429ed", () => {
    const { lane: l } = lane(1);
    l.on429(undefined, 1000); // 0 -> 8000
    l.on429(undefined, 20_000); // 429 at 8000 -> 16000
    for (let i = 0; i < 100; i++) l.onClean();
    expect(l.settings.gapMs).toBe(10_000);
  });
});

describe("adaptive perHost", () => {
  const tune: Tuning = { ...tuning, perHostCleanRequests: 3, perHostHoldMs: 1000 };
  const mk = (perHost = 2, ceiling = 4) => {
    const d = def("ashby", 2);
    d.settings.perHost = perHost;
    d.settings.perHostCeiling = ceiling;
    d.floors = { slow: { perHost: 1 } };
    const events: string[] = [];
    return { events, lane: new Lane(d, [], tune, (m) => events.push(m)) };
  };
  const clean = (l: Lane, n: number, at: number) => {
    for (let i = 0; i < n; i++) l.observe(200, undefined, at);
  };

  it("climbs while clean and stops at the ceiling", () => {
    const { lane: l } = mk();
    clean(l, 3, 1000);
    expect(l.settings.perHost).toBe(3);
    clean(l, 3, 1001);
    expect(l.settings.perHost).toBe(4);
    clean(l, 30, 1002);
    expect(l.settings.perHost).toBe(4);
    expect(l.perHostWhy).toContain("clean requests");
  });

  it("halves on a 429, holds down, then probes below the value that failed", () => {
    const { lane: l } = mk(4, 6);
    l.observe(429, undefined, 5000);
    expect(l.settings.perHost).toBe(2);
    expect(l.perHostWhy).toContain("429");
    clean(l, 10, 5500);
    expect(l.settings.perHost).toBe(2);
    clean(l, 3, 6100);
    expect(l.settings.perHost).toBe(3);
    clean(l, 30, 6200);
    expect(l.settings.perHost).toBe(3);
  });

  it("never drops below 1 and detailConcurrency follows perHost, capped at 8 and by the platform floor", () => {
    const { lane: l } = mk(1, 12);
    l.observe(429, undefined, 100);
    expect(l.settings.perHost).toBe(1);
    expect(l.detailConcurrency("ashby")).toBe(1);
    l.setPerHost(12);
    expect(l.detailConcurrency("ashby")).toBe(8);
    expect(l.detailConcurrency("slow")).toBe(1);
  });

  it("an edit to perHostCeiling is validated and clamps perHost", () => {
    expect(readEdits({ lanes: { ashby: { perHostCeiling: 0 } } }, ["ashby"]).errors).toHaveLength(
      1,
    );
    const { lane: l } = mk(4, 6);
    l.setPerHostCeiling(2);
    expect(l.settings.perHost).toBe(2);
  });

  it("round-trips learned.json, and ignores it when stale", async () => {
    const run = async (now: number, seed?: object) => {
      const lanes = [def("ashby", 1)];
      lanes[0]!.settings.perHostCeiling = 6;
      const s = new Sweep({
        lanes,
        work: new Map([["ashby", [board("ashby", "a")]]]),
        runBoard: async (_src, lane) => {
          lane.observe(429, undefined, now);
          return ok;
        },
        paths: sweepPaths(dir),
        tuning: tune,
        timing: fast,
        now: () => now,
        random: () => 0.5,
      });
      void seed;
      await s.run();
      return s;
    };
    dir = mkdtempSync(join(tmpdir(), "sweep-"));
    const t = Date.now();
    const first = await run(t);
    expect(first.lanes[0]!.learned).toBe(false);
    const saved = JSON.parse(readFileSync(sweepPaths(dir).learned, "utf8"));
    expect(saved.lanes.ashby.perHost).toBe(1);
    expect(saved.lanes.ashby.perHostBad).toBe(2);
    const second = await run(t + 60_000);
    expect(second.lanes[0]!.learned).toBe(true);
    expect(second.status().lanes.ashby!.learned).toBe(true);
    const stale = await run(t + 8 * 24 * 3_600_000);
    expect(stale.lanes[0]!.learned).toBe(false);
  });
});

describe("pods", () => {
  const wd = (key: string, pod: string): SourceConfig => ({
    id: `workday:${key}`,
    platform: "workday",
    key,
    company: key,
    params: { wd: pod },
  });
  const podLane = (boards: SourceConfig[], perHost = 1) => {
    const d = def("workday", 4);
    d.platforms = ["workday"];
    d.multiHost = true;
    d.settings.perHost = perHost;
    return new Lane(d, boards, { ...tuning, perHostCleanRequests: 3 }, () => {});
  };

  it("keys tenants of one pod together and leaves other hosts alone", () => {
    expect(podKey("lennar.wd1.myworkdayjobs.com")).toBe("wd1.myworkdayjobs.com");
    expect(podKey("jll.wd1.myworkdayjobs.com")).toBe("wd1.myworkdayjobs.com");
    expect(podKey("x.wd501.myworkdayjobs.com")).toBe("wd501.myworkdayjobs.com");
    expect(podKey("eeho.fa.us2.oraclecloud.com")).toBe("fa.us2.oraclecloud.com");
    expect(podKey("jpmc.fa.oraclecloud.com")).toBe("fa.oraclecloud.com");
    expect(podKey("boards.greenhouse.io")).toBe("boards.greenhouse.io");
    expect(boardGroup(wd("jll/x", "wd1"))).toBe("wd1.myworkdayjobs.com");
  });

  it("the limiter shares one queue per pod", async () => {
    const limiter = createHostLimiter({ perHostConcurrency: 1, hostKey: podKey });
    let running = 0;
    let peak = 0;
    const task = async () => {
      peak = Math.max(peak, ++running);
      await sleep(5);
      running--;
    };
    await Promise.all(
      ["a.wd1.myworkdayjobs.com", "b.wd1.myworkdayjobs.com", "c.wd1.myworkdayjobs.com"].map((h) =>
        limiter.run(h, task),
      ),
    );
    expect(peak).toBe(1);
  });

  it("skips boards of a full pod and takes one from another pod", () => {
    const l = podLane([wd("a/x", "wd1"), wd("b/x", "wd1"), wd("c/x", "wd5")]);
    const first = l.take(0)!;
    l.inFlight.set(first.source.id, 0);
    const second = l.take(0)!;
    expect(first.source.key).toBe("a/x");
    expect(second.source.key).toBe("c/x");
    l.inFlight.set(second.source.id, 0);
    expect(l.take(0)).toBeUndefined();
    l.inFlight.delete(first.source.id);
    expect(l.take(0)!.source.key).toBe("b/x");
  });

  it("spreads boards over pods: a board whose pod is idle starts before another on a busy pod", () => {
    const l = podLane([], 6);
    const at = (wd: string, key: string): SourceConfig => ({
      ...board("workday", key),
      params: { wd },
    });
    l.pending.push(at("wd1", "a/1"), at("wd1", "a/2"), at("wd2", "b/1"));
    const first = l.take(0)!;
    l.inFlight.set(first.source.id, 0); // `take` already recorded its pod
    const second = l.take(0)!;
    expect(second.source.id).toBe("workday:b/1");
  });

  it("a 429 on one pod halves that pod only, and the status lists it", () => {
    const l = podLane([], 4);
    l.observe(429, undefined, 1000, "jll.wd1.myworkdayjobs.com");
    const pods = l.pods();
    expect(pods["wd1.myworkdayjobs.com"]).toMatchObject({ perHost: 2, r429: 1 });
    expect(l.settings.perHost).toBe(4);
    for (let i = 0; i < 3; i++) l.observe(200, undefined, 2000, "x.wd1.myworkdayjobs.com");
    expect(l.pods()["wd1.myworkdayjobs.com"]!.perHost).toBe(3);
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
    expect(events).toEqual([`workday: wd5.myworkdayjobs.com 429, host gap 0 -> 2000 ms`]);
    lane.on429(undefined, 20_000, A);
    expect(lane.hostSlowdown().worstGapMs).toBe(4000);
  });

  it("honors Retry-After for the host gap, without holding the lane", () => {
    const { lane } = mk(multi(6));
    lane.on429(30_000, 1000, A);
    expect(lane.hostSlowdown().worstGapMs).toBe(30_000);
    expect(lane.cooldownUntil).toBe(0);
  });

  it("slows the lane's start gap, not its parallelism, when several hosts say 429", () => {
    const { lane, events } = mk(multi(6));
    lane.on429(undefined, 1000, A);
    lane.on429(undefined, 100_000, B); // A's 429 is too old
    expect(lane.settings.gapMs).toBe(0);
    lane.on429(undefined, 110_000, A);
    expect(lane.settings.gapMs).toBe(500); // retryAfterGapMs
    expect(lane.settings.concurrency).toBe(6);
    expect(events.at(-1)).toBe("workday: 429 on 2+ hosts, gap 0 -> 500 ms");
  });

  it("decays a host gap after clean requests", () => {
    const { lane } = mk(multi(6));
    lane.on429(undefined, 1000, A);
    for (let i = 0; i < 10; i++) lane.observe(200, undefined, 2000, A);
    expect(lane.hostSlowdown().worstGapMs).toBe(1000);
    for (let i = 0; i < 30; i++) lane.observe(200, undefined, 3000, A);
    expect(lane.hostSlowdown()).toEqual({ slowed: 0, worstGapMs: 0 });
  });

  it("caps one host's gap at 30 s, not the lane's 2 minutes", () => {
    const { lane } = mk(multi(6));
    lane.on429(undefined, 1000, A);
    lane.on429(undefined, 20_000, A);
    lane.on429(undefined, 40_000, A);
    lane.on429(undefined, 60_000, A);
    lane.on429(undefined, 80_000, A);
    expect(lane.hostSlowdown().worstGapMs).toBe(30_000);
  });

  it("walks a quiet host's gap back down on the clock, not on clean requests", () => {
    const { lane, events } = mk(multi(6));
    lane.on429(undefined, 1000, A);
    expect(lane.hostSlowdown().worstGapMs).toBe(2000);
    lane.tick(1000 + 60_000);
    expect(lane.hostSlowdown().worstGapMs).toBe(2000);
    lane.tick(1000 + 150_000);
    expect(lane.hostSlowdown().worstGapMs).toBe(1000);
    expect(events.at(-1)).toBe("workday: wd5.myworkdayjobs.com quiet, host gap 2000 -> 1000 ms");
    lane.tick(1000 + 300_000);
    expect(lane.hostSlowdown().worstGapMs).toBe(500);
    lane.tick(1000 + 700_000);
    lane.tick(1000 + 1_100_000);
    expect(lane.hostSlowdown()).toEqual({ slowed: 0, worstGapMs: 0 });
  });

  it("keeps the lane's concurrency and perHost when most pods are healthy", () => {
    const { lane, events } = mk(multi(20));
    // Six pods busy; only two of them complain. `take` is what records a board's pod (Workday: params.wd).
    for (let i = 0; i < 6; i++)
      lane.pending.push({
        ...board("workday", `tenant${i}/Site`),
        params: { wd: `wd${i}` },
      });
    for (let i = 0; i < 6; i++) {
      const taken = lane.take(0)!;
      lane.inFlight.set(taken.source.id, 1000);
    }
    lane.on429(undefined, 1000, "tenant0.wd0.myworkdayjobs.com");
    lane.on429(undefined, 2000, "tenant1.wd1.myworkdayjobs.com");
    expect(lane.settings.concurrency).toBe(20);
    expect(lane.settings.perHost).toBe(2);
    expect(events.some((e) => e.includes("429 on several hosts"))).toBe(false);
    // The complaining pods themselves are still slowed, and by their own numbers.
    expect(lane.pods()["wd0.myworkdayjobs.com"]!.gapMs).toBe(2000);
  });

  it("a single-host lane keeps the lane-wide behavior", () => {
    const { lane } = mk(def("greenhouse", 4));
    lane.observe(429, undefined, 1000, "boards-api.greenhouse.io");
    expect(lane.settings.concurrency).toBe(2);
    expect(lane.settings.gapMs).toBe(8000);
    expect(lane.hostSlowdown().slowed).toBe(0);
  });
});

describe("learned limits", () => {
  it("restores a faster gap than the configured start, and a slower one", () => {
    const mk = () => {
      const events: string[] = [];
      const lane = new Lane(def("walmart", 1, 700, 250), [], tuning, (m) => events.push(m));
      return { events, lane };
    };
    const fast = mk().lane;
    fast.applyLearned(
      { at: 0, perHost: 2, gapMs: 250, last429At: null, perHostBad: null, hosts: {} },
      1000,
    );
    expect(fast.settings.gapMs).toBe(250);
    const slow = mk().lane;
    slow.applyLearned(
      { at: 0, perHost: 2, gapMs: 4000, last429At: null, perHostBad: null, hosts: {} },
      1000,
    );
    expect(slow.settings.gapMs).toBe(4000);
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
    expect(status.global.capacity).toBe(Math.floor(status.global.maxInFlight / 2));
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
    expect(classifyError(new TypeError("Cannot read properties of undefined")).kind).toBe(
      "permanent",
    );
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

describe("timings", () => {
  const timings = (over: Partial<Timings> = {}): Timings => ({
    listMs: 600,
    diffMs: 50,
    detailMs: 400,
    cpuMs: 100,
    uploadMs: 30,
    finalizeMs: 20,
    limiterWaitMs: 300,
    retryWaitMs: 100,
    sourceRequests: 20,
    ingestCalls: 5,
    bytesIn: 1000,
    wallMs: 1200,
    ...over,
  });

  it("shares are computed with the waits taken out of the source time", () => {
    const lt = new LaneTimings();
    lt.record(timings());
    const s = lt.summary();
    // source 1000 - 400 waits = 600; limiter 300; cpu 100; ingest 100; retry 100; total 1200
    expect(s.shares).toEqual({
      source: 0.5,
      limiterWait: 0.25,
      cpu: 0.083,
      ingest: 0.083,
      retryWait: 0.083,
    });
    expect(s.requestsPerSecPerBoard).toBeCloseTo(16.67, 1);
    expect(sharesLine(s.shares)).toBe(
      "source 50%, limiter wait 25%, cpu 8%, ingest 8%, retry waits 8%",
    );
  });

  it("p50 and p90 of board wall time", () => {
    const lt = new LaneTimings();
    for (let i = 1; i <= 10; i++) lt.record(timings(), i * 1000);
    const s = lt.summary();
    expect(s.wallP50Ms).toBe(5000);
    expect(s.wallP90Ms).toBe(9000);
  });

  it("splits the source time into paging and posting fetches", () => {
    const lt = new LaneTimings();
    lt.record(timings()); // list 600, detail 400
    expect(lt.summary().phases).toEqual({ list: 0.6, detail: 0.4 });
    const paging = new LaneTimings();
    paging.record(timings({ listMs: 1000, detailMs: 0, limiterWaitMs: 0, retryWaitMs: 0 }));
    const w = paging.takeWindow()!;
    expect(w.phases.list).toBe(1);
    expect(bottleneckMessage("workday", w.top, w.shares, 2, w.phases)).toMatch(
      /\d+% of time in source responses, 100% of it paging the listing: more boards in parallel, not perHost/,
    );
  });

  it("names the dominant bottleneck, with the perHost hint for the limiter", () => {
    const lt = new LaneTimings();
    lt.record(timings({ listMs: 900, detailMs: 0, limiterWaitMs: 800, retryWaitMs: 0 }));
    const w = lt.takeWindow()!;
    expect(w.top).toBe("limiterWait");
    expect(bottleneckMessage("smartrecruiters", w.top, w.shares, 3)).toMatch(
      /smartrecruiters: \d+% of time waiting on the host limiter \(perHost 3\): room to raise perHost/,
    );
    expect(lt.takeWindow()).toBeNull();
  });

  it("the sweep aggregates per lane, reports it in status and the formatted table, and logs an event", async () => {
    const run: RunBoard = async () => {
      await sleep(10);
      return {
        outcome: outcome({ timings: timings({ wallMs: 10 }) }),
        cost: { rows: 1, r2Puts: 0 },
      };
    };
    const { sweep } = setup([def("workday", 2)], { workday: ["a", "b", "c"] }, run);
    await sweep.run();
    const t = sweep.status().lanes.workday!.timings;
    expect(t.boards).toBe(3);
    expect(t.sourceRequests).toBe(60);
    expect(t.shares.source).toBe(0.5);
    const text = formatStatus(sweep.status(), []);
    expect(text).toContain("where the time goes");
    expect(text).toContain("workday: source 50%, limiter wait 25%");
    expect(JSON.parse(JSON.stringify(sweep.status())).lanes.workday.timings.shares.cpu).toBe(0.083);
    await until(() => sweep.events.some((e) => e.includes("workday: ")), 500).catch(() => {});
  });

  it("emits a bottleneck event per lane each interval", async () => {
    const run: RunBoard = async () => {
      await sleep(5);
      return { outcome: outcome({ timings: timings() }), cost: { rows: 1, r2Puts: 0 } };
    };
    const many = Array.from({ length: 40 }, (_, i) => `b${i}`);
    const { sweep } = setup([def("workday", 1)], { workday: many }, run);
    await sweep.run();
    expect(sweep.events.some((e) => e.includes("of time in source responses"))).toBe(true);
  });
});

it("refuses to overwrite corrupt or invalid control files", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ctl-corrupt-")), "control.json");
  for (const original of ["{broken", "[]", "null", '{"global":{"maxInFlight":0}}']) {
    writeFileSync(path, original);
    expect(() => setControl(path, ["ashby"], "global", ["paused=false"])).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  }
});

it("classifies structured failures independently of numbers in their text", () => {
  const partial = { listingComplete: false, detailsComplete: false };
  expect(
    classifyOutcome(
      outcome({
        ...partial,
        issues: [
          {
            code: "http",
            message: "404 is part of this URL",
            retryable: true,
            status: 429,
            retryAfterMs: 1000,
          },
        ],
      }),
    ),
  ).toMatchObject({ kind: "retryable", retryAfterMs: 1000 });
  expect(
    classifyOutcome(
      outcome({
        ...partial,
        issues: [{ code: "schema", message: "row 503 is invalid", retryable: false }],
      }),
    ),
  ).toMatchObject({ kind: "permanent" });
});
