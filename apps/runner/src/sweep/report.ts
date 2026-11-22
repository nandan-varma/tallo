import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SweepStatus } from "./controller.ts";
import { editPath } from "./controller.ts";
import { type Edit, parseWord, readEdits } from "./settings.ts";

const pad = (v: string | number, n: number, right = false) =>
  right ? String(v).padStart(n) : String(v).padEnd(n);
const clock = (sec: number) =>
  `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
const short = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

/** A compact table for the owner, plus the last events. Pure. */
export function formatStatus(status: SweepStatus, events: string[], now = Date.now()): string {
  const g = status.global;
  const c = status.cost;
  const age = Math.round((now - Date.parse(status.updatedAt)) / 1000);
  const stale =
    status.state === "running" && age > 20 ? `  (status ${age}s old: is it running?)` : "";
  const lines = [
    `sweep ${status.state}  elapsed ${clock(status.elapsedSec)}  in-flight ${g.inFlight}/${g.capacity} (max ${g.maxInFlight})${g.paused ? "  PAUSED" : ""}${g.stop ? "  STOPPING" : ""}${stale}`,
    `cost  ~${short(c.rowsWritten)} D1 rows of ${short(c.budget)} (${c.budgetUsedPct}%)${c.budgetHeld ? " HELD" : ""}  ${short(c.rowsPerMin)} rows/min  ${short(c.r2Puts)} R2 puts  ingest ${g.ingestLatencyMs} ms`,
    "",
    `${pad("lane", 16)}${pad("state", 11)}${pad("due", 6, true)}${pad("done", 6, true)}${pad("perm", 5, true)}${pad("stuck", 6, true)}${pad("defer", 6, true)}${pad("run", 4, true)}${pad("conc", 6, true)}${pad("gap", 7, true)}${pad("429", 5, true)}${pad("b/min", 7, true)}${pad("req/min", 8, true)}${pad("eta", 7, true)}`,
  ];
  for (const [name, l] of Object.entries(status.lanes)) {
    lines.push(
      `${pad(name, 16)}${pad(l.state, 11)}${pad(l.due, 6, true)}${pad(l.done, 6, true)}${pad(l.failedPermanent, 5, true)}${pad(l.stuck, 6, true)}${pad(l.deferred, 6, true)}${pad(l.inFlight.length, 4, true)}${pad(`${l.concurrency}/${l.ceiling}`, 6, true)}${pad(l.gapMs, 7, true)}${pad(l.r429, 5, true)}${pad(l.boardsPerMin, 7, true)}${pad(Math.round(l.requestsPerMin), 8, true)}${pad(l.etaMin === null ? "-" : `${l.etaMin}m`, 7, true)}`,
    );
  }
  const extra: string[] = [];
  for (const [name, l] of Object.entries(status.lanes)) {
    if (l.nextRetryAt)
      extra.push(`${name}: ${l.deferred} deferred, next retry ${l.nextRetryAt.slice(11, 19)}Z`);
    for (const b of l.inFlight.filter((x) => x.runningSec >= 120))
      extra.push(`${name}: ${b.id} running ${b.runningSec}s`);
    if (l.errors[0]) extra.push(`${name}: last error ${l.errors[0]}`);
  }
  if (extra.length) lines.push("", ...extra);
  lines.push("", `last ${events.length} events`);
  for (const line of events) {
    try {
      const e = JSON.parse(line) as { t: string; level: string; message: string };
      lines.push(`  ${e.t.slice(11, 19)} ${e.level === "warn" ? "!" : " "} ${e.message}`);
    } catch {
      lines.push(`  ${line}`);
    }
  }
  return lines.join("\n");
}

/** The last `n` lines of events.jsonl, or none when it does not exist. */
export function tailEvents(path: string, n: number): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

function readControlFile(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Atomic write, so the running sweep never reads half a file. */
function writeControlFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Edit the control file: `target` is a lane name, `global` or `budget`; `pairs` are `key=value`.
 * Validates before writing; throws with every problem, so the file is never made worse.
 */
export function setControl(
  path: string,
  laneNames: readonly string[],
  target: string,
  pairs: string[],
  now = Date.now(),
): Edit[] {
  const values: Record<string, number | boolean | string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error(`Expected key=value, got "${pair}"`);
    values[pair.slice(0, eq)] = parseWord(pair.slice(eq + 1));
  }
  const patch =
    target === "global" || target === "budget"
      ? { [target]: values }
      : { lanes: { [target]: values } };
  if (target !== "global" && target !== "budget" && !laneNames.includes(target))
    throw new Error(`Unknown lane "${target}". Lanes: ${laneNames.join(", ")}, or global, budget`);
  const { edits, errors } = readEdits(patch, laneNames);
  if (errors.length) throw new Error(errors.join("\n"));
  const file = readControlFile(path);
  const stamps = { ...((file._stamps as Record<string, number> | undefined) ?? {}) };
  for (const edit of edits) {
    const section = edit.scope === "lane" ? "lanes" : edit.scope;
    const holder = (file[section] ?? {}) as Record<string, unknown>;
    if (edit.scope === "lane") {
      const lane = (holder[edit.lane as string] ?? {}) as Record<string, unknown>;
      holder[edit.lane as string] = { ...lane, [edit.key]: edit.value };
    } else holder[edit.key] = edit.value;
    file[section] = holder;
    stamps[editPath(edit)] = now;
  }
  file._stamps = stamps;
  writeControlFile(path, file);
  return edits;
}
