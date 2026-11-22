import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Outcome } from "@tallo/collect";
import type { SourceConfig } from "@tallo/contracts";
import { classifyError, classifyOutcome, type Verdict } from "./classify.ts";
import { Lane, TUNING, type Tuning } from "./lane.ts";
import { DEFAULT_BUDGET, DEFAULT_GLOBAL, type Edit, type LaneDef, readEdits } from "./settings.ts";

/** What one board attempt cost, estimated from the run result. */
export interface Cost {
  rows: number;
  r2Puts: number;
}

/** Runs one board on its lane. Resolves with the run outcome, or throws. */
export type RunBoard = (
  source: SourceConfig,
  lane: Lane,
) => Promise<{ outcome: Outcome; cost: Cost }>;

export interface SweepPaths {
  control: string;
  status: string;
  events: string;
}
export const sweepPaths = (dir: string, control?: string): SweepPaths => ({
  control: control ?? join(dir, "control.json"),
  status: join(dir, "status.json"),
  events: join(dir, "events.jsonl"),
});

export interface Timing {
  tickMs: number;
  controlMs: number;
  statusMs: number;
  /** Ingest pressure: pause starts this long when the API gave no Retry-After. */
  pressurePauseMs: number;
  /** Clean time before in-flight capacity grows back by one. */
  recoverMs: number;
  /** Smoothed ingest latency that counts as pressure. */
  latencySpikeMs: number;
}
export const TIMING: Timing = {
  tickMs: 250,
  controlMs: 3000,
  statusMs: 5000,
  pressurePauseMs: 5000,
  recoverMs: 20_000,
  latencySpikeMs: 15_000,
};

export interface SweepOptions {
  lanes: LaneDef[];
  /** Due boards by lane name, in work order. Fixed for the whole sweep. */
  work: Map<string, SourceConfig[]>;
  runBoard: RunBoard;
  paths: SweepPaths;
  tuning?: Tuning;
  timing?: Timing;
  now?: () => number;
  random?: () => number;
}

const round = (n: number) => Math.round(n * 10) / 10;
const minutes = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
const boardName = (id: string) => id.slice(id.indexOf(":") + 1);

/** The in-process adaptive controller: lanes, deferral, global guard, cost meter, control file, status. */
export class Sweep {
  readonly lanes: Lane[];
  readonly events: string[] = [];
  readonly startedAt: number;
  private opts: SweepOptions;
  private tuning: Tuning;
  private timing: Timing;
  private now: () => number;
  private random: () => number;
  private global = { ...DEFAULT_GLOBAL };
  private budget = { ...DEFAULT_BUDGET };
  /** In-flight capacity after the D1 guard: shrinks on pressure, grows back one at a time. */
  private capacity: number;
  private startsPausedUntil = 0;
  private lastPressure = 0;
  private lastRecover = 0;
  private latency = 0;
  private stopping = false;
  private budgetHeld = false;
  private budgetMarks = new Set<number>();
  private rows = 0;
  private r2Puts = 0;
  private lastControl = "";
  private lastErrorLog = "";
  private lastStatusAt = 0;
  private lastControlAt = 0;
  private resolveDone?: (reason: "finished" | "stopped") => void;
  private timer?: ReturnType<typeof setInterval>;
  private state: "running" | "draining" | "finished" | "stopped" = "running";

  constructor(opts: SweepOptions) {
    this.opts = opts;
    this.tuning = opts.tuning ?? TUNING;
    this.timing = opts.timing ?? TIMING;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.startedAt = this.now();
    this.capacity = this.global.maxInFlight;
    this.lanes = opts.lanes.map(
      (def) => new Lane(def, opts.work.get(def.name) ?? [], this.tuning, (m) => this.event(m)),
    );
  }

  event(message: string, level: "info" | "warn" = "info"): void {
    const line = JSON.stringify({ t: new Date(this.now()).toISOString(), level, message });
    this.events.push(`${line}`);
    if (this.events.length > 200) this.events.shift();
    try {
      mkdirSync(dirname(this.opts.paths.events), { recursive: true });
      appendFileSync(this.opts.paths.events, `${line}\n`);
    } catch {
      // Reporting must never stop a sweep.
    }
  }

  /** Observe one ingest API response: a 503 or a latency spike shrinks capacity and pauses starts. */
  observeApi(status: number, latencyMs: number, retryAfterMs?: number): void {
    const now = this.now();
    this.latency = this.latency === 0 ? latencyMs : this.latency * 0.8 + latencyMs * 0.2;
    const hot = status === 503 || status === 429 || status === 502 || status === 504;
    if (!hot && this.latency < this.timing.latencySpikeMs) return;
    this.lastPressure = now;
    if (now < this.startsPausedUntil) return;
    const pause = retryAfterMs ?? this.timing.pressurePauseMs;
    this.startsPausedUntil = now + Math.min(pause, 5 * 60_000);
    const before = this.capacity;
    this.capacity = Math.max(2, Math.floor(this.capacity / 2));
    this.event(
      `ingest pressure (${hot ? `HTTP ${status}` : `latency ${Math.round(this.latency)} ms`}): in-flight cap ${before} -> ${this.capacity}, new starts paused ${minutes(pause)}`,
      "warn",
    );
  }

  /** Runs until every lane is done, or a stop drains it. */
  run(): Promise<"finished" | "stopped"> {
    this.event(`sweep started: ${this.lanes.map((l) => `${l.name} ${l.due}`).join(", ")}`);
    this.readControl(true);
    return new Promise((resolve) => {
      this.resolveDone = resolve;
      this.timer = setInterval(() => this.tick(), this.timing.tickMs);
      this.tick();
    });
  }

  /** Ask for a graceful drain, as `tallo sweep stop` or a signal does. */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.state = "draining";
    this.event(`stop requested: draining ${this.inFlight()} in-flight boards, starting no more`);
  }

  inFlight(): number {
    return this.lanes.reduce((n, l) => n + l.inFlight.size, 0);
  }

  private tick(): void {
    const now = this.now();
    if (now - this.lastControlAt >= this.timing.controlMs) this.readControl();
    this.checkBudget();
    if (
      this.capacity < this.global.maxInFlight &&
      now - this.lastPressure >= this.timing.recoverMs &&
      now - this.lastRecover >= this.timing.recoverMs
    ) {
      this.lastRecover = now;
      this.capacity++;
      this.event(`ingest recovered: in-flight cap -> ${this.capacity}`);
    }
    if (this.capacity > this.global.maxInFlight) this.capacity = this.global.maxInFlight;
    this.pump();
    const over =
      this.lanes.every((l) => !l.settings.enabled || l.finished) ||
      (this.stopping && this.inFlight() === 0);
    if (now - this.lastStatusAt >= this.timing.statusMs || over) this.writeStatus();
    if (over) {
      if (this.timer) clearInterval(this.timer);
      this.state = this.stopping ? "stopped" : "finished";
      this.event(this.stopping ? "sweep stopped (drained)" : "sweep finished");
      this.writeStatus();
      this.resolveDone?.(this.stopping ? "stopped" : "finished");
    }
  }

  /** Start boards while there is room, one lane at a time so no lane starves another. */
  private pump(): void {
    const now = this.now();
    if (this.stopping || this.global.paused || this.budgetHeld || now < this.startsPausedUntil)
      return;
    for (let started = true; started; ) {
      started = false;
      for (const lane of this.lanes) {
        const s = lane.settings;
        if (this.inFlight() >= this.capacity) return;
        if (!s.enabled || s.paused || now < lane.cooldownUntil) continue;
        if (lane.inFlight.size >= s.concurrency) continue;
        const next = lane.take(now);
        if (!next) continue;
        this.start(lane, next.source, next.attempts);
        started = true;
      }
    }
  }

  private start(lane: Lane, source: SourceConfig, attempts: number): void {
    const startedAt = this.now();
    const r429Before = lane.r429;
    lane.inFlight.set(source.id, startedAt);
    this.opts.runBoard(source, lane).then(
      ({ outcome, cost }) => {
        this.rows += cost.rows;
        this.r2Puts += cost.r2Puts;
        this.finish(lane, source, attempts, classifyOutcome(outcome), lane.r429 === r429Before);
      },
      (error) => this.finish(lane, source, attempts, classifyError(error), false),
    );
  }

  private finish(
    lane: Lane,
    source: SourceConfig,
    attempts: number,
    verdict: Verdict,
    clean: boolean,
  ): void {
    const now = this.now();
    lane.inFlight.delete(source.id);
    const name = boardName(source.id);
    if (verdict.kind === "ok") {
      lane.done++;
      lane.completions.push(now);
      if (clean) lane.onClean();
    } else if (verdict.kind === "permanent") {
      lane.failedPermanent++;
      lane.note(`${name}: ${verdict.reason}`);
      this.event(`${lane.name}: ${name} failed:permanent (${verdict.reason})`, "warn");
    } else {
      const tried = attempts + 1;
      lane.note(`${name}: ${verdict.reason}`);
      if (tried >= this.tuning.maxAttempts) {
        lane.stuck++;
        this.event(
          `${lane.name}: ${name} stuck after ${tried} attempts (${verdict.reason})`,
          "warn",
        );
      } else {
        const wait = Math.max(lane.deferDelay(tried, this.random), verdict.retryAfterMs ?? 0);
        lane.deferred.push({
          source,
          attempts: tried,
          notBefore: now + wait,
          reason: verdict.reason,
        });
        this.event(`${lane.name}: ${name} deferred ${minutes(wait)} (${verdict.reason})`);
      }
    }
    this.checkBudget();
    this.pump();
  }

  private checkBudget(): void {
    const used = this.rows / this.budget.maxRowsWritten;
    for (const mark of [0.5, 0.8]) {
      if (used >= mark && !this.budgetMarks.has(mark)) {
        this.budgetMarks.add(mark);
        this.event(
          `budget ${mark * 100}% used (${Math.round(this.rows)} of ${this.budget.maxRowsWritten} rows)`,
          "warn",
        );
      }
    }
    if (used >= 1 && !this.budgetHeld) {
      this.budgetHeld = true;
      this.event(
        `budget reached (${Math.round(this.rows)} estimated rows written): all lanes paused. Owner: raise budget.maxRowsWritten to continue, or stop`,
        "warn",
      );
    } else if (used < 1 && this.budgetHeld) {
      this.budgetHeld = false;
      this.event("budget raised: lanes resume");
    }
  }

  /** Apply the control file. Only values that changed in the file since the last read are applied. */
  private readControl(first = false): void {
    this.lastControlAt = this.now();
    let text: string;
    try {
      text = readFileSync(this.opts.paths.control, "utf8");
    } catch {
      return;
    }
    if (text === this.lastControl) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      if (this.lastErrorLog !== text) this.event("control.json is not valid JSON: ignored", "warn");
      this.lastErrorLog = text;
      return;
    }
    const names = this.lanes.map((l) => l.name);
    const before = this.lastControl ? readEdits(safeParse(this.lastControl), names).edits : [];
    const stampsBefore = stampsOf(safeParse(this.lastControl));
    const stampsNow = stampsOf(raw);
    this.lastControl = text;
    const { edits, errors } = readEdits(raw, names);
    for (const message of errors) this.event(`control ignored: ${message}`, "warn");
    for (const edit of edits) {
      const prior = before.find(
        (b) => b.scope === edit.scope && b.lane === edit.lane && b.key === edit.key,
      );
      // `tallo sweep set` stamps what it writes, so an edit is applied even when the value in the file is
      // the same as before but the lane has moved on since (AIMD lowered it).
      const path = editPath(edit);
      if (prior?.value === edit.value && stampsBefore[path] === stampsNow[path]) continue;
      // The first read of a fresh sweep applies everything except a stale stop.
      if (first && edit.scope === "global" && edit.key === "stop") continue;
      this.apply(edit);
    }
  }

  private apply(edit: Edit): void {
    const where = edit.scope === "lane" ? edit.lane : edit.scope;
    if (edit.scope === "global") {
      if (edit.key === "stop") return void (edit.value && this.stop());
      const key = edit.key as "maxInFlight" | "paused";
      const old = this.global[key];
      Object.assign(this.global, { [key]: edit.value });
      // A raised limit opens at once; the D1 guard still shrinks it on pressure.
      if (key === "maxInFlight") this.capacity = edit.value as number;
      this.event(`control: global.${key} ${old} -> ${edit.value}`);
    } else if (edit.scope === "budget") {
      this.event(`control: budget.maxRowsWritten ${this.budget.maxRowsWritten} -> ${edit.value}`);
      this.budget.maxRowsWritten = edit.value as number;
      this.budgetMarks.clear();
    } else {
      const lane = this.lanes.find((l) => l.name === edit.lane);
      if (!lane) return;
      const key = edit.key as keyof Lane["settings"];
      const old = lane.settings[key];
      if (key === "concurrency") lane.setConcurrency(edit.value as number);
      else if (key === "ceiling") lane.setCeiling(edit.value as number);
      else if (key === "gapMs") lane.setGap(edit.value as number);
      else {
        Object.assign(lane.settings, { [key]: edit.value });
        if (key === "perHost") lane.applyLimits();
      }
      this.event(`control: ${where}.${key} ${old} -> ${lane.settings[key]}`);
    }
  }

  status() {
    const now = this.now();
    const elapsedMs = now - this.startedAt;
    const lanes = Object.fromEntries(
      this.lanes.map((l) => {
        const s = l.settings;
        const rate = l.rates(now, this.startedAt);
        const left = l.pending.length + l.deferred.length + l.inFlight.size;
        const next = l.deferred.reduce<number | null>(
          (min, d) => (min === null || d.notBefore < min ? d.notBefore : min),
          null,
        );
        const laneState = !s.enabled
          ? "disabled"
          : l.finished
            ? "done"
            : s.paused || this.global.paused
              ? "paused"
              : this.budgetHeld
                ? "budget-hold"
                : now < l.cooldownUntil
                  ? "cooling"
                  : !l.hasReady(now) && !l.inFlight.size
                    ? "waiting"
                    : "running";
        return [
          l.name,
          {
            state: laneState,
            due: l.due,
            done: l.done,
            pending: l.pending.length,
            failedPermanent: l.failedPermanent,
            stuck: l.stuck,
            deferred: l.deferred.length,
            nextRetryAt: next === null ? null : new Date(next).toISOString(),
            inFlight: [...l.inFlight].map(([id, at]) => ({
              id,
              runningSec: Math.round((now - at) / 1000),
            })),
            requests: l.requests,
            r429: l.r429,
            concurrency: s.concurrency,
            ceiling: s.ceiling,
            perHost: s.perHost,
            gapMs: s.gapMs,
            boardsPerMin: round(rate.boardsPerMin),
            requestsPerMin: round(rate.requestsPerMin),
            etaMin: rate.boardsPerMin > 0 && left > 0 ? Math.round(left / rate.boardsPerMin) : null,
            errors: l.errors,
          },
        ];
      }),
    );
    const rowsPerMin = elapsedMs > 0 ? (this.rows / elapsedMs) * 60_000 : 0;
    return {
      updatedAt: new Date(now).toISOString(),
      startedAt: new Date(this.startedAt).toISOString(),
      elapsedSec: Math.round(elapsedMs / 1000),
      pid: process.pid,
      state: this.state === "running" && this.global.paused ? "paused" : this.state,
      global: {
        inFlight: this.inFlight(),
        maxInFlight: this.global.maxInFlight,
        capacity: this.capacity,
        paused: this.global.paused,
        stop: this.stopping,
        startsPausedUntil:
          now < this.startsPausedUntil ? new Date(this.startsPausedUntil).toISOString() : null,
        ingestLatencyMs: Math.round(this.latency),
      },
      cost: {
        rowsWritten: Math.round(this.rows),
        r2Puts: this.r2Puts,
        rowsPerMin: Math.round(rowsPerMin),
        budget: this.budget.maxRowsWritten,
        budgetUsedPct: round((this.rows / this.budget.maxRowsWritten) * 100),
        budgetHeld: this.budgetHeld,
      },
      lanes,
    };
  }

  private writeStatus(): void {
    this.lastStatusAt = this.now();
    try {
      mkdirSync(dirname(this.opts.paths.status), { recursive: true });
      const tmp = `${this.opts.paths.status}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.status(), null, 2));
      renameSync(tmp, this.opts.paths.status);
    } catch {
      // Reporting must never stop a sweep.
    }
  }
}

export type SweepStatus = ReturnType<Sweep["status"]>;

/** The path of an edit in the control file, e.g. `lanes.ashby.concurrency`. */
export const editPath = (e: Edit) =>
  e.scope === "lane" ? `lanes.${e.lane}.${e.key}` : `${e.scope}.${e.key}`;

function stampsOf(raw: unknown): Record<string, unknown> {
  const stamps = (raw as { _stamps?: unknown } | undefined)?._stamps;
  return stamps && typeof stamps === "object" ? (stamps as Record<string, unknown>) : {};
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
