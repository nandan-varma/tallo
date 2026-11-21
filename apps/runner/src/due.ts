import { emptyBackoffSeconds, needsLocalEgress, type SourceConfig } from "@tallo/contracts";

/** `tallo sync` staleness cutoff in hours: the default for the cloud-free path, and for `--local-egress`. */
export const CLOUD_STALE_HOURS = 20;
export const LOCAL_EGRESS_STALE_HOURS = 168;

/** Which sources a sync run should collect, and which boards are dead or empty. Pure: no I/O. */

export interface SourceState {
  id: string;
  company: string;
  status: "active" | "dead";
  consecutiveFailures: number;
  lastRunAt: number | null;
  lastCompleteRunAt: number | null;
  /** Status of the most recent run: only a complete run can say a board is empty. */
  lastStatus?: string | null;
  /** Last run that listed any postings (null if none in the retained runs). */
  lastPostingsAt?: number | null;
}

interface DueOptions {
  platform?: string;
  /** Platforms to skip (`--exclude-platform`). Nothing is excluded by default. */
  excludePlatforms?: readonly string[];
  source?: string;
  includeDead?: boolean;
  /** Skip sources whose last complete run is at or after this epoch second. */
  cutoff: number;
  limit?: number;
  /** Epoch seconds, for the empty-board back-off. Defaults to now. */
  now?: number;
}

/**
 * Sources to sync, oldest complete run first. Dead boards are skipped unless `includeDead`.
 * Boards whose last run was complete but empty, for a while, wait out `emptyBackoffSeconds`.
 * An explicit `source` bypasses the staleness cutoff and the back-off, but not the dead check.
 */
export function dueSources<T extends { id: string; platform: string }>(
  configured: T[],
  state: Map<
    string,
    Pick<SourceState, "status" | "lastCompleteRunAt" | "lastStatus" | "lastPostingsAt">
  >,
  options: DueOptions,
): T[] {
  const now = options.now ?? Date.now() / 1000;
  const last = (id: string) => state.get(id)?.lastCompleteRunAt ?? 0;
  const backedOff = (id: string) => {
    const row = state.get(id);
    if (row?.lastStatus !== "complete") return false;
    return now - last(id) < emptyBackoffSeconds(row.lastPostingsAt, now);
  };
  const due = configured
    .filter((s) => !options.platform || s.platform === options.platform)
    .filter((s) => !options.excludePlatforms?.includes(s.platform))
    .filter((s) => !options.source || s.id === options.source)
    .filter((s) => options.includeDead || state.get(s.id)?.status !== "dead")
    .filter((s) => options.source || last(s.id) < options.cutoff)
    .filter((s) => options.source || !backedOff(s.id))
    .sort((a, b) => last(a.id) - last(b.id));
  return options.limit ? due.slice(0, options.limit) : due;
}

/**
 * The boards only the Mac can reach (`params.egress: "local"`), for `tallo sync --local-egress`.
 * Feed the result to `dueSources` like any other list, so the cutoff and back-off still apply.
 */
export function localEgressSources<T extends Pick<SourceConfig, "params">>(configured: T[]): T[] {
  return configured.filter((s) => needsLocalEgress(s));
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
