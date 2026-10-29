/**
 * When a board is next collected. Pure policy: the Worker's cron, the finalize step and the status
 * page all read the same numbers from here.
 */

/** `hot`: large employers, collected daily. `normal` and `rare`: weekly. */
export const TIERS = ["hot", "normal", "rare"] as const;
export type Tier = (typeof TIERS)[number];

const DAY = 86400;

export const SCHEDULE = {
  interval: { hot: DAY, normal: 7 * DAY, rare: 7 * DAY },
  /** A board seen dead (repeated 404s) is checked rarely: it may come back. */
  deadInterval: 30 * DAY,
  /** A partial run is retried well before the next weekly turn: a transient failure should not cost a week. */
  retryAfterPartial: 6 * 3600,
  /** Claim window for a board handed to a collector. A dead collector frees the board after this. */
  leaseSeconds: 30 * 60,
} as const;

/** How a finished run ended, as far as scheduling is concerned. */
export type RunOutcome = "complete" | "partial" | "dead";

/** Epoch second at which a board is due again, after a run that ended with `outcome` at `finishedAt`. */
export function nextDueAt(input: { tier: Tier; outcome: RunOutcome; finishedAt: number }): number {
  const { tier, outcome, finishedAt } = input;
  if (outcome === "dead") return finishedAt + SCHEDULE.deadInterval;
  if (outcome === "complete") return finishedAt + SCHEDULE.interval[tier];
  return finishedAt + SCHEDULE.retryAfterPartial;
}

/** Epoch second until which a claimed board is leased (not due again). */
export const leaseUntil = (now: number): number => now + SCHEDULE.leaseSeconds;

/** Board tier from the reviewed hot list. Anything not on it is `normal`. */
export const tierFor = (hot: boolean): Tier => (hot ? "hot" : "normal");
