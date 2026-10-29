import { createHostLimiter } from "@tallo/http";
import { describe, expect, it } from "vitest";
import { gatedLimiter, policyFor, policyForHost, reserveSlot } from "../src/index.ts";

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
    expect(policyFor("greenhouse")).toEqual({ concurrency: 8, gapMs: 0 });
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
