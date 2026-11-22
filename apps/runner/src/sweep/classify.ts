import { failureOf } from "@tallo/http";

export { parseRetryAfter } from "@tallo/http";

import type { Outcome } from "@tallo/collect";

/** What a finished board attempt means for the sweep. */
export type Verdict =
  | { kind: "ok" }
  | { kind: "retryable"; reason: string; retryAfterMs?: number; busy?: true }
  | { kind: "permanent"; reason: string };

/** A board that threw (ingest 503 'Database busy', 409 busy, network, or a bug). */
export function classifyError(error: unknown): Verdict {
  const text = error instanceof Error ? error.message : String(error);
  const failure = failureOf(error);
  const after = failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs };
  if (failure.retryable)
    return {
      kind: "retryable",
      reason:
        failure.status === 409
          ? "409 busy"
          : failure.status
            ? `HTTP ${failure.status}`
            : text.slice(0, 120),
      ...(failure.status === 409 ? { busy: true } : {}),
      ...after,
    };
  // Validation and bugs: a retry would fail the same way.
  return { kind: "permanent", reason: text.slice(0, 160) };
}

/**
 * The engine turns most failures into a partial run with issues rather than a throw. A run that
 * finished its listing and details is ok; a board that does not exist, or answers in a shape the
 * platform cannot read, is permanent; everything else that did not finish is worth another try.
 */
export function classifyOutcome(outcome: Outcome): Verdict {
  if (outcome.listingComplete && outcome.detailsComplete) return { kind: "ok" };
  if (outcome.notModified) return { kind: "ok" };
  if (outcome.boardNotFound) return { kind: "permanent", reason: "404 board gone" };
  const issues = outcome.issues;
  const retry = issues.find((i) => i.retryable === true);
  if (retry) {
    const busy = retry.status === 409;
    return {
      kind: "retryable",
      reason: retry.message.slice(0, 120),
      ...(busy ? { busy: true } : {}),
      ...(retry.retryAfterMs === undefined ? {} : { retryAfterMs: retry.retryAfterMs }),
    };
  }
  const fatal = issues.find(
    (i) =>
      i.retryable === false || i.code === "schema" || i.code === "blocked" || i.code === "budget",
  );
  if (fatal) return { kind: "permanent", reason: `${fatal.code}: ${fatal.message.slice(0, 120)}` };
  return {
    kind: "retryable",
    reason: issues[0]?.message.slice(0, 120) ?? "incomplete run",
  };
}
