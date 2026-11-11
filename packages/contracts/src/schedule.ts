/**
 * When a board is next collected. Pure policy: the Worker's cron, the finalize step and the status
 * page all read the same numbers from here.
 */

/** `hot`: large employers, collected daily. `normal` and `rare`: weekly. */
export const TIERS = ["hot", "normal", "rare"] as const;
export type Tier = (typeof TIERS)[number];

const HOUR = 3600;
const DAY = 86400;

export const SCHEDULE = {
  interval: { hot: DAY, normal: 7 * DAY, rare: 7 * DAY },
  /** A board seen dead (repeated 404s) is checked rarely: it may come back. */
  deadInterval: 30 * DAY,
  /**
   * Back-off after a failed or partial run, indexed by failed runs in a row minus one: the first retry is
   * after 1h, then 3h, 6h, and 24h for every later failure. A complete run resets the count.
   */
  backoff: [1 * HOUR, 3 * HOUR, 6 * HOUR, 24 * HOUR],
  /**
   * A board that has never listed anything (no run ever listed postings or a complete listing) waits the
   * dead interval after this many failed runs in a row. It stays active: this is not a dead verdict.
   */
  neverListedFailures: 10,
  /**
   * Retry after a 409 `busy` (another run holds the board). Not a failure. Applied as a floor: a later
   * schedule set by the run that holds the board is kept.
   */
  busyRetry: 15 * 60,
  /** Claim window for a board handed to a collector. A dead collector frees the board after this. */
  leaseSeconds: 30 * 60,
} as const;

/** How a finished run ended, as far as scheduling is concerned. */
export type RunOutcome = "complete" | "partial" | "dead";

/**
 * Epoch second at which a board is due again, after a run that ended with `outcome` at `finishedAt`.
 * `failures` counts failed runs in a row including this one (0 after a complete run); `neverListed` is
 * true when no run of the board has ever listed anything.
 */
export function nextDueAt(input: {
  tier: Tier;
  outcome: RunOutcome;
  finishedAt: number;
  failures: number;
  neverListed: boolean;
}): number {
  const { tier, outcome, finishedAt, failures, neverListed } = input;
  if (outcome === "dead") return finishedAt + SCHEDULE.deadInterval;
  if (outcome === "complete") return finishedAt + SCHEDULE.interval[tier];
  const streak = Math.max(1, failures);
  if (neverListed && streak >= SCHEDULE.neverListedFailures) {
    return finishedAt + SCHEDULE.deadInterval;
  }
  const step =
    SCHEDULE.backoff[Math.min(streak, SCHEDULE.backoff.length) - 1] ?? SCHEDULE.backoff[0];
  return finishedAt + step;
}

/** Epoch second until which a claimed board is leased (not due again). */
export const leaseUntil = (now: number): number => now + SCHEDULE.leaseSeconds;

/** Board tier from the reviewed hot list. Anything not on it is `normal`. */
export const tierFor = (hot: boolean): Tier => (hot ? "hot" : "normal");
