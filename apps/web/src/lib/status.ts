/** Pure helpers for the source health page. Inputs mirror `/v1/sources` and `/v1/runs`. */

/** Computed by the API from the last listing time (7 and 14 day thresholds). Inferred, not recorded. */
export type Freshness = "fresh" | "stale" | "hidden";

export interface SourceRecord {
  id: string;
  platform: string;
  company: string;
  key: string;
  lastRunAt: number | null;
  lastCompleteRunAt: number | null;
  lastListedAt: number | null;
  lastStatus: string | null;
  freshness: Freshness;
}

export interface RunIssue {
  code: string;
  message: string;
  url?: string;
  postingId?: string;
}

export interface RunRecord {
  id: string;
  sourceId: string;
  runnerId: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "complete" | "partial";
  seen: number | null;
  added: number;
  changed: number;
  closed: number | null;
  issues: RunIssue[] | null;
}

export interface SourceSummary {
  total: number;
  /** Configured sources that have never run. Shown as a count only, never listed. */
  neverCollected: number;
  fresh: number;
  stale: number;
  hidden: number;
  /** Latest run of any source, or null when nothing has run. */
  lastCollectedAt: number | null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Relative age in coarse units. Callers handle null (unknown) themselves. */
export function since(epochSeconds: number, now = nowSeconds()): string {
  const seconds = Math.max(0, now - epochSeconds);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function summarizeSources(sources: SourceRecord[]): SourceSummary {
  const summary: SourceSummary = {
    total: sources.length,
    neverCollected: 0,
    fresh: 0,
    stale: 0,
    hidden: 0,
    lastCollectedAt: null,
  };
  for (const source of sources) {
    if (source.lastRunAt === null) summary.neverCollected++;
    else summary[source.freshness]++;
    if (source.lastRunAt !== null && (summary.lastCollectedAt ?? 0) < source.lastRunAt) {
      summary.lastCollectedAt = source.lastRunAt;
    }
  }
  return summary;
}

export interface PlatformSummary extends SourceSummary {
  platform: string;
}

/** Per-platform breakdown, sorted by platform name. */
export function summarizeByPlatform(sources: SourceRecord[]): PlatformSummary[] {
  const groups = new Map<string, SourceRecord[]>();
  for (const source of sources) {
    const group = groups.get(source.platform) ?? [];
    group.push(source);
    groups.set(source.platform, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, group]) => ({ platform, ...summarizeSources(group) }));
}

/**
 * Sources that have run but are stale, hidden from search, or whose latest run was partial.
 * Oldest listing first, so the worst boards lead. Never-collected sources are excluded.
 */
export function attentionSources(sources: SourceRecord[], limit = 100) {
  const flagged = sources.filter(
    (s) => s.lastRunAt !== null && (s.freshness !== "fresh" || s.lastStatus === "partial"),
  );
  flagged.sort((a, b) => (a.lastListedAt ?? 0) - (b.lastListedAt ?? 0));
  return { total: flagged.length, sources: flagged.slice(0, limit) };
}

/** Counts worth showing for a run. Null (not measured) fields are omitted. */
export function runCounts(run: RunRecord): { label: string; value: number }[] {
  const counts: { label: string; value: number | null }[] = [
    { label: "seen", value: run.seen },
    { label: "added", value: run.added },
    { label: "changed", value: run.changed },
    { label: "closed", value: run.closed },
  ];
  return counts.filter((c): c is { label: string; value: number } => c.value !== null);
}

export const FRESHNESS_LABEL: Record<Freshness, string> = {
  fresh: "Fresh",
  stale: "Stale",
  hidden: "Hidden",
};
