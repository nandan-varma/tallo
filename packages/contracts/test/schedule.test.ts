import { describe, expect, it } from "vitest";
import { leaseUntil, nextDueAt, SCHEDULE, tierFor } from "../src/schedule.ts";

const DAY = 86400;
const HOUR = 3600;
const t0 = 1_800_000_000;

/** A failed run that listed something before (so the never-listed rule does not apply). */
const failed = (failures: number) => ({
  tier: "normal" as const,
  outcome: "partial" as const,
  finishedAt: t0,
  failures,
  neverListed: false,
});

describe("nextDueAt", () => {
  it("a complete run is due again after its tier's interval, counted from finish", () => {
    const complete = {
      outcome: "complete" as const,
      finishedAt: t0,
      failures: 0,
      neverListed: false,
    };
    expect(nextDueAt({ ...complete, tier: "hot" })).toBe(t0 + DAY);
    expect(nextDueAt({ ...complete, tier: "normal" })).toBe(t0 + 7 * DAY);
    expect(nextDueAt({ ...complete, tier: "rare" })).toBe(t0 + 7 * DAY);
  });

  it("a complete run ignores earlier failures: the back-off is over", () => {
    expect(nextDueAt({ ...failed(5), outcome: "complete", failures: 0 })).toBe(t0 + 7 * DAY);
  });

  it("a dead board waits thirty days, whatever its tier", () => {
    for (const tier of ["hot", "normal", "rare"] as const) {
      expect(
        nextDueAt({ tier, outcome: "dead", finishedAt: t0, failures: 3, neverListed: false }),
      ).toBe(t0 + 30 * DAY);
    }
  });

  it("backs off 1h, 3h, 6h, then 24h for every later failure, capped there", () => {
    expect(nextDueAt(failed(1))).toBe(t0 + 1 * HOUR);
    expect(nextDueAt(failed(2))).toBe(t0 + 3 * HOUR);
    expect(nextDueAt(failed(3))).toBe(t0 + 6 * HOUR);
    expect(nextDueAt(failed(4))).toBe(t0 + 24 * HOUR);
    expect(nextDueAt(failed(9))).toBe(t0 + 24 * HOUR);
    expect(nextDueAt(failed(50))).toBe(t0 + 24 * HOUR);
  });

  it("the back-off ladder is the same for every tier", () => {
    for (const tier of ["hot", "normal", "rare"] as const) {
      expect(nextDueAt({ ...failed(2), tier })).toBe(t0 + 3 * HOUR);
    }
  });

  it("a board that never listed anything waits the dead interval after ten failures, and stays active", () => {
    const never = { ...failed(SCHEDULE.neverListedFailures), neverListed: true };
    expect(nextDueAt(never)).toBe(t0 + 30 * DAY);
    expect(nextDueAt({ ...never, failures: 9 })).toBe(t0 + 24 * HOUR);
    expect(nextDueAt({ ...never, failures: 1 })).toBe(t0 + 1 * HOUR);
  });

  it("a board that listed before keeps the 24-hour cap after ten failures", () => {
    expect(nextDueAt({ ...failed(10), neverListed: false })).toBe(t0 + 24 * HOUR);
  });

  it("is never in the past relative to the finish time", () => {
    for (const outcome of ["complete", "partial", "dead"] as const) {
      expect(
        nextDueAt({ tier: "hot", outcome, finishedAt: t0, failures: 1, neverListed: true }),
      ).toBeGreaterThan(t0);
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
