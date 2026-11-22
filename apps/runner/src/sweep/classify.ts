import type { Outcome } from "@tallo/collect";

/** What a finished board attempt means for the sweep. */
export type Verdict =
  | { kind: "ok" }
  | { kind: "retryable"; reason: string; retryAfterMs?: number }
  | { kind: "permanent"; reason: string };

const RETRYABLE =
  /\b(429|408|409|5\d\d)\b|busy|timed? ?out|timeout|network|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|reset|Upload failed/i;

/** Seconds or an HTTP date, as a delay in ms. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The status a thrown error carries (ky HTTPError, @tallo/http HttpError), if any. */
function statusOf(error: unknown): number | undefined {
  const e = error as { status?: unknown; response?: { status?: unknown } } | null;
  const status = e?.response?.status ?? e?.status;
  return typeof status === "number" && status > 0 ? status : undefined;
}

/** A board that threw (ingest 503 'Database busy', 409 busy, network, or a bug). */
export function classifyError(error: unknown): Verdict {
  const text = error instanceof Error ? error.message : String(error);
  const status = statusOf(error);
  const headers = (error as { response?: { headers?: Headers } } | null)?.response?.headers;
  const retryAfterMs = parseRetryAfter(headers?.get?.("retry-after"));
  const after = retryAfterMs === undefined ? {} : { retryAfterMs };
  if (status !== undefined) {
    if (status === 409) return { kind: "retryable", reason: "409 busy", ...after };
    if (status === 408 || status === 429 || status >= 500)
      return { kind: "retryable", reason: `HTTP ${status}`, ...after };
    return { kind: "permanent", reason: `HTTP ${status}: ${text.slice(0, 120)}` };
  }
  if (error instanceof TypeError || RETRYABLE.test(text))
    return { kind: "retryable", reason: text.slice(0, 120), ...after };
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
  const retry = issues.find((i) => RETRYABLE.test(i.message));
  if (retry) return { kind: "retryable", reason: retry.message.slice(0, 120) };
  const fatal = issues.find(
    (i) => i.code === "schema" || i.code === "blocked" || i.code === "budget",
  );
  if (fatal) return { kind: "permanent", reason: `${fatal.code}: ${fatal.message.slice(0, 120)}` };
  return {
    kind: "retryable",
    reason: issues[0]?.message.slice(0, 120) ?? "incomplete run",
  };
}
