/** Jobs `purgeClosed` deletes per call (its page). A full page means more may be waiting. */
export const PURGE_PAGE = 1000;
/** Purge pages per hourly invocation. The next hour continues where this one stopped. */
export const MAX_PURGE_PAGES = 20;
/** Regroup pages per hourly invocation (each page is up to 3000 keys). The next hour continues. */
export const MAX_REGROUP_PAGES = 20;

/** The hourly housekeeping steps, each already bound to its database and blob store. */
export interface Housekeeping {
  reapStaleRuns(): Promise<unknown>;
  repairSchedule(): Promise<unknown>;
  /** Deletes up to `PURGE_PAGE` closed jobs and returns how many it deleted. */
  purgeClosed(): Promise<number>;
  pruneRuns(): Promise<unknown>;
  /** One regroup page after `after`; `next` is the cursor for the following page, or null when done. */
  regroupPage(after: string): Promise<{ next: string | null }>;
}

export interface HousekeepingEvent {
  step: string;
  outcome: "error" | "budget";
  error?: string;
}

/**
 * Runs every hourly step, in order, each in isolation: a step that throws is reported and the rest still run.
 * Purge and regroup loop only within a fixed page budget, so one invocation's work is bounded.
 */
export async function housekeeping(
  ops: Housekeeping,
  report: (event: HousekeepingEvent) => void,
): Promise<void> {
  const purge = async (): Promise<HousekeepingEvent["outcome"] | null> => {
    for (let page = 0; page < MAX_PURGE_PAGES; page++) {
      if ((await ops.purgeClosed()) < PURGE_PAGE) return null;
    }
    return "budget";
  };
  const regroup = async (): Promise<HousekeepingEvent["outcome"] | null> => {
    let after = "";
    for (let page = 0; page < MAX_REGROUP_PAGES; page++) {
      const { next } = await ops.regroupPage(after);
      if (next === null) return null;
      after = next;
    }
    return "budget";
  };
  const once = (task: () => Promise<unknown>) => async () => {
    await task();
    return null;
  };
  const steps: [string, () => Promise<HousekeepingEvent["outcome"] | null>][] = [
    ["reapStaleRuns", once(() => ops.reapStaleRuns())],
    ["repairSchedule", once(() => ops.repairSchedule())],
    ["purgeClosed", purge],
    ["pruneRuns", once(() => ops.pruneRuns())],
    ["regroup", regroup],
  ];
  for (const [step, run] of steps) {
    try {
      const budget = await run();
      if (budget) report({ step, outcome: budget });
    } catch (error) {
      report({
        step,
        outcome: "error",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  }
}
