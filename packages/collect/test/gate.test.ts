import { createHostLimiter } from "@tallo/http";
import { describe, expect, it } from "vitest";
import { batchedGate, gatedLimiter, policyFor, policyForHost, reserveSlot } from "../src/index.ts";

describe("reserveSlot", () => {
  it("a free host starts now, and is busy for one gap afterwards", () => {
    expect(reserveSlot(0, 1000, 250)).toEqual({ waitMs: 0, nextFreeAt: 1250 });
  });

  it("a busy host makes the caller wait until its slot, and the slots are spaced by the gap", () => {
    // Three callers arrive together at t=1000 with a 250ms gap.
    let next = 0;
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = reserveSlot(next, 1000, 250);
      waits.push(r.waitMs);
      next = r.nextFreeAt;
    }
    expect(waits).toEqual([0, 250, 500]);
    expect(next).toBe(1750);
  });

  it("an idle host does not bank credit: a late caller starts at once", () => {
    expect(reserveSlot(1250, 5000, 250)).toEqual({ waitMs: 0, nextFreeAt: 5250 });
  });
});

describe("reserveSlot with a block", () => {
  it("reserves consecutive slots in one call and keeps the gap after the last", () => {
    expect(reserveSlot(0, 1000, 250, 4)).toEqual({ waitMs: 0, nextFreeAt: 2000 });
    // The next caller queues behind the whole block.
    expect(reserveSlot(2000, 1000, 250, 4)).toEqual({ waitMs: 1000, nextFreeAt: 3000 });
  });
});

describe("batchedGate", () => {
  /** A fake clock, and a fake HostGate: one nextFreeAt per host, counting calls. */
  function world() {
    let clock = 10_000;
    const free = new Map<string, number>();
    const calls: { host: string; count: number }[] = [];
    const starts: number[] = [];
    const reserve = async (host: string, gapMs: number, count: number) => {
      calls.push({ host, count });
      const slot = reserveSlot(free.get(host) ?? 0, clock, gapMs, count);
      free.set(host, slot.nextFreeAt);
      return slot.waitMs;
    };
    const advance = (ms: number) => {
      clock += ms;
    };
    const sleep = async (ms: number) => advance(ms);
    const gate = (count = 4) => batchedGate(reserve, { count, now: () => clock, sleep });
    return {
      calls,
      starts,
      gate,
      now: () => clock,
      advance,
    };
  }

  it("takes one reserve call per block, not one per request", async () => {
    const w = world();
    const gate = w.gate(4);
    for (let i = 0; i < 10; i++) {
      await gate("a.myworkdayjobs.com", 250);
      w.starts.push(w.now());
    }
    expect(w.calls).toHaveLength(3); // ceil(10 / 4); one call per request before
    expect(w.calls.every((c) => c.count === 4)).toBe(true);
    for (let i = 1; i < w.starts.length; i++)
      expect(w.starts[i]! - w.starts[i - 1]!).toBeGreaterThanOrEqual(250);
  });

  it("keeps the gap between starts across two isolates sharing a host", async () => {
    const w = world();
    const a = w.gate(3);
    const b = w.gate(3);
    const starts: number[] = [];
    // Interleave callers from two invocations; the shared fake clock only moves when someone sleeps.
    for (let i = 0; i < 6; i++) {
      await (i % 2 ? a : b)("x.myworkdayjobs.com", 250);
      starts.push(w.now());
    }
    const sorted = [...starts].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++)
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(250);
  });

  it("a late caller is spaced from its previous start and never runs past its window", async () => {
    const w = world();
    const gate = w.gate(3);
    const starts: number[] = [];
    await gate("h", 250);
    starts.push(w.now());
    w.advance(1000); // slow request: the next slot time is long past
    await gate("h", 250);
    starts.push(w.now());
    await gate("h", 250);
    starts.push(w.now());
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(250);
    // The window was [10000, 10500]; the third start (11250) is outside it, so a new block was reserved.
    expect(w.calls).toHaveLength(2);
  });

  it("ends the window at the reserved slots, not after the reserve response latency", async () => {
    let clock = 10_000;
    const calls: number[] = [];
    const reserve = async () => {
      calls.push(clock);
      clock += 400; // the Durable Object call takes 400 ms to answer; its slots were fixed at the start
      return 0;
    };
    const gate = batchedGate(reserve, { count: 3, now: () => clock, sleep: async () => {} });
    await gate("h", 250);
    expect(clock).toBe(10_400);
    // Reserved slots: 10000, 10250, 10500. The next start (10650) is past the last one, so the
    // gate must reserve again rather than trust a window stretched by the latency (to 10900).
    clock += 250;
    await gate("h", 250);
    expect(calls).toEqual([10_000, 10_650]);
  });

  it("logs when it proceeds without a slot", async () => {
    let clock = 0;
    const logs: string[] = [];
    const gate = batchedGate(async () => 0, {
      count: 1,
      now: () => clock++ * 1000,
      sleep: async () => {},
      log: (m) => logs.push(m),
    });
    await Promise.all([gate("busy", 250), gate("busy", 250), gate("busy", 250), gate("busy", 250)]);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain("busy");
  });

  it("concurrent callers share one in-flight reserve call", async () => {
    const w = world();
    const gate = w.gate(4);
    await Promise.all([gate("h", 250), gate("h", 250), gate("h", 250)]);
    expect(w.calls).toHaveLength(1);
  });

  it("hosts have their own windows", async () => {
    const w = world();
    const gate = w.gate(4);
    await gate("a", 250);
    await gate("b", 250);
    expect(w.calls.map((c) => c.host)).toEqual(["a", "b"]);
  });
});

describe("gatedLimiter", () => {
  it("passes through the gate only for hosts with a gap, and only once per request", async () => {
    const gated: string[] = [];
    const limiter = gatedLimiter(
      createHostLimiter({ perHostConcurrency: 4 }),
      (host) => (host.endsWith(".myworkdayjobs.com") ? 250 : 0),
      async (host, gap) => {
        gated.push(`${host}:${gap}`);
      },
    );
    const value = await limiter.run("boards.greenhouse.io", async () => "fast");
    const slow = await limiter.run("acme.wd5.myworkdayjobs.com", async () => "slow");
    expect([value, slow]).toEqual(["fast", "slow"]);
    expect(gated).toEqual(["acme.wd5.myworkdayjobs.com:250"]);
  });

  it("runs the task after the gate resolves, not before", async () => {
    const order: string[] = [];
    const limiter = gatedLimiter(
      createHostLimiter(),
      () => 100,
      async () => {
        order.push("gate");
      },
    );
    await limiter.run("x.myworkdayjobs.com", async () => {
      order.push("task");
    });
    expect(order).toEqual(["gate", "task"]);
  });
});

describe("policy", () => {
  it("public JSON boards are fast; tenant platforms are gapped and narrow", () => {
    expect(policyFor("greenhouse")).toEqual({ concurrency: 4, gapMs: 0 });
    expect(policyFor("workday")).toEqual({ concurrency: 2, gapMs: 250 });
    expect(policyFor("oraclecloud")).toEqual({ concurrency: 2, gapMs: 250 });
  });

  it("an unknown platform gets the careful policy", () => {
    expect(policyFor("somewhere-new")).toEqual({ concurrency: 2, gapMs: 250 });
  });

  it("finds the policy for a host by the platform allowlist", () => {
    expect(policyForHost("boards-api.greenhouse.io").gapMs).toBe(0);
    expect(policyForHost("acme.wd1.myworkdayjobs.com").gapMs).toBe(250);
    expect(policyForHost("nowhere.example").gapMs).toBe(250);
  });
});
