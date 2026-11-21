import { describe, expect, it, vi } from "vitest";
import {
  type Housekeeping,
  type HousekeepingEvent,
  housekeeping,
  MAX_PURGE_PAGES,
  MAX_REGROUP_PAGES,
  PURGE_PAGE,
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

  it("keeps purging while a page is full, and stops at the first short page", async () => {
    const counts = [PURGE_PAGE, PURGE_PAGE, 7];
    const ops = fakes({ purgeClosed: vi.fn(async () => counts.shift() ?? 0) });
    expect(await run(ops)).toEqual([]);
    expect(ops.purgeClosed).toHaveBeenCalledTimes(3);
  });

  it("bounds the purge loop per invocation and reports that it stopped", async () => {
    const ops = fakes({ purgeClosed: vi.fn(async () => PURGE_PAGE) });
    const events = await run(ops);
    expect(ops.purgeClosed).toHaveBeenCalledTimes(MAX_PURGE_PAGES);
    expect(events).toEqual([{ step: "purgeClosed", outcome: "budget" }]);
  });

  it("follows the regroup cursor from the start until it is exhausted", async () => {
    const pages = [{ next: "k1" }, { next: "k2" }, { next: null }];
    const ops = fakes({ regroupPage: vi.fn(async () => pages.shift() ?? { next: null }) });
    expect(await run(ops)).toEqual([]);
    expect(vi.mocked(ops.regroupPage).mock.calls.map((c) => c[0])).toEqual(["", "k1", "k2"]);
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
