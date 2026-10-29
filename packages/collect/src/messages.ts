import type { Progress } from "./engine.ts";

/**
 * What the `tallo-collect` queue carries. Small on purpose: the plan (listing and diff) and the raw
 * parts live in scratch, keyed by run id, and the progress says how far the run has got.
 */
export type CollectMessage =
  /** Start a run for a board. The run id is chosen when the message is sent, so a retry is idempotent. */
  | { kind: "start"; sourceId: string; runId: string }
  /** Continue a run from `progress.offset`. */
  | { kind: "slice"; sourceId: string; runId: string; progress: Progress };
