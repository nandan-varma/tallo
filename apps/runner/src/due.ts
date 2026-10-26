/** Which sources a sync run should collect, and which boards are dead. Pure: no I/O. */

export interface SourceState {
  id: string;
  company: string;
  status: "active" | "dead";
  consecutiveFailures: number;
  lastRunAt: number | null;
  lastCompleteRunAt: number | null;
}

interface DueOptions {
  platform?: string;
  source?: string;
  includeDead?: boolean;
  /** Skip sources whose last complete run is at or after this epoch second. */
  cutoff: number;
  limit?: number;
}

/**
 * Sources to sync, oldest complete run first. Dead boards are skipped unless `includeDead`.
 * An explicit `source` bypasses the staleness cutoff, but not the dead check.
 */
export function dueSources<T extends { id: string; platform: string }>(
  configured: T[],
  state: Map<string, Pick<SourceState, "status" | "lastCompleteRunAt">>,
  options: DueOptions,
): T[] {
  const last = (id: string) => state.get(id)?.lastCompleteRunAt ?? 0;
  const due = configured
    .filter((s) => !options.platform || s.platform === options.platform)
    .filter((s) => !options.source || s.id === options.source)
    .filter((s) => options.includeDead || state.get(s.id)?.status !== "dead")
    .filter((s) => options.source || last(s.id) < options.cutoff)
    .sort((a, b) => last(a.id) - last(b.id));
  return options.limit ? due.slice(0, options.limit) : due;
}

/** Sources the server has marked dead, by id. Remove them from `sources/` once reviewed. */
export function deadSources(rows: SourceState[]): SourceState[] {
  return rows.filter((r) => r.status === "dead").sort((a, b) => a.id.localeCompare(b.id));
}

/** One line per dead board, for `tallo sources --dead`. */
export function formatDead(rows: SourceState[]): string {
  if (rows.length === 0) return "No dead boards.";
  const lines = rows.map((r) => {
    const last = r.lastRunAt ? new Date(r.lastRunAt * 1000).toISOString().slice(0, 10) : "never";
    return `${r.id}\t${r.company}\t404 x${r.consecutiveFailures}\tlast run ${last}`;
  });
  return `${rows.length} dead (remove from sources/ to stop tracking):\n${lines.join("\n")}`;
}
