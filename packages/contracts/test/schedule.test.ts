import { describe, expect, it } from "vitest";
import { leaseUntil, nextDueAt, SCHEDULE, tierFor } from "../src/schedule.ts";

const DAY = 86400;
const t0 = 1_800_000_000;

describe("nextDueAt", () => {
  it("a complete run is due again after its tier's interval, counted from finish", () => {
    expect(nextDueAt({ tier: "hot", outcome: "complete", finishedAt: t0 })).toBe(t0 + DAY);
    expect(nextDueAt({ tier: "normal", outcome: "complete", finishedAt: t0 })).toBe(t0 + 7 * DAY);
    expect(nextDueAt({ tier: "rare", outcome: "complete", finishedAt: t0 })).toBe(t0 + 7 * DAY);
  });

  it("a dead board waits thirty days, whatever its tier", () => {
    for (const tier of ["hot", "normal", "rare"] as const) {
      expect(nextDueAt({ tier, outcome: "dead", finishedAt: t0 })).toBe(t0 + 30 * DAY);
    }
  });

  it("a partial run is retried in six hours, not a week later", () => {
    expect(nextDueAt({ tier: "normal", outcome: "partial", finishedAt: t0 })).toBe(t0 + 6 * 3600);
  });

  it("is never in the past relative to the finish time", () => {
    for (const outcome of ["complete", "partial", "dead"] as const) {
      expect(nextDueAt({ tier: "hot", outcome, finishedAt: t0 })).toBeGreaterThan(t0);
    }
  });
});

describe("leases and tiers", () => {
  it("a claim leases the board for the lease window", () => {
    expect(leaseUntil(t0)).toBe(t0 + SCHEDULE.leaseSeconds);
    expect(SCHEDULE.leaseSeconds).toBe(1800);
  });

  it("the hot list decides the tier; everything else is normal", () => {
    expect(tierFor(true)).toBe("hot");
    expect(tierFor(false)).toBe("normal");
  });
});
