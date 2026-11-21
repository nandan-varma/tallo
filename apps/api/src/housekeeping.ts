/**
 * Closed jobs purged per hourly invocation. The Worker's subrequest cap (1000) is shared by the whole invocation,
 * and purging one job costs up to three subrequests (R2 get, R2 delete, and the D1 re-check that puts a blob
 * back if a reference appeared meanwhile), plus a few statements per call. 150 jobs is at most ~450 for the
 * purge, which leaves room for the regroup pages and the other steps. The rest waits for the next hour.
 */
export const PURGE_JOBS_PER_RUN = 150;
/**
 * Regroup pages per hourly invocation (each page is up to 3000 keys, and costs roughly 20-80 subrequests). The
 * unfinished pass is recorded after each page, so the next hour resumes it.
 */
export const MAX_REGROUP_PAGES = 4;

/** The hourly housekeeping steps, each already bound to its database and blob store. */
export interface Housekeeping {
  reapStaleRuns(): Promise<unknown>;
  repairSchedule(): Promise<unknown>;
  /** Deletes up to `limit` closed jobs and returns how many it deleted. */
  purgeClosed(limit: number): Promise<number>;
  pruneRuns(): Promise<unknown>;
  /**
   * One regroup page. `after` is the cursor the previous page returned; undefined resumes the unfinished pass
   * recorded by an earlier invocation, or starts a new one. `next` is null when the pass is complete.
   */
  regroupPage(after: string | undefined): Promise<{ next: string | null }>;
}

export interface HousekeepingEvent {
  step: string;
  outcome: "error" | "budget";
  error?: string;
}

/**
 * Runs every hourly step, in order, each in isolation: a step that throws is reported and the rest still run.
 * Each step does a bounded amount of work per invocation. A step that stops with work left reports `budget`,
 * and the next invocation continues from the state it left behind.
 */
export async function housekeeping(
  ops: Housekeeping,
  report: (event: HousekeepingEvent) => void,
): Promise<void> {
  const purge = async (): Promise<HousekeepingEvent["outcome"] | null> =>
    (await ops.purgeClosed(PURGE_JOBS_PER_RUN)) >= PURGE_JOBS_PER_RUN ? "budget" : null;
  const regroup = async (): Promise<HousekeepingEvent["outcome"] | null> => {
    let after: string | undefined;
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
