import type { SourceConfig } from "@tallo/contracts";
import { createHostLimiter, type HostLimiter } from "@tallo/http";
import type { LaneDef, LaneSettings } from "./settings.ts";

export interface Tuning {
  /** Clean boards in a row before a lane raises its concurrency by one and shrinks its gap. */
  cleanBoards: number;
  /** One 429 burst reduces a lane once per this window. */
  decreaseWindowMs: number;
  /** First gap after a 429 that came without Retry-After (Microsoft answers plain 429s). */
  noRetryAfterGapMs: number;
  /** First gap after a 429 that came with Retry-After. */
  retryAfterGapMs: number;
  gapCapMs: number;
  /** Cap on how long one Retry-After may hold a lane. */
  maxRetryAfterMs: number;
  /** Deferral: first delay, doubled per attempt, jittered, capped. */
  deferBaseMs: number;
  deferCapMs: number;
  /** A board is tried this many times, then marked stuck. */
  maxAttempts: number;
}

export const TUNING: Tuning = {
  cleanBoards: 5,
  decreaseWindowMs: 10_000,
  noRetryAfterGapMs: 8000,
  retryAfterGapMs: 500,
  gapCapMs: 120_000,
  maxRetryAfterMs: 10 * 60_000,
  deferBaseMs: 60_000,
  deferCapMs: 30 * 60_000,
  maxAttempts: 4,
};

export interface Deferred {
  source: SourceConfig;
  attempts: number;
  notBefore: number;
  reason: string;
}

export type Emit = (message: string) => void;

/** One platform group: its queue, its host limits, its failures, and the AIMD that tunes them. */
export class Lane {
  readonly name: string;
  readonly platforms: string[];
  readonly settings: LaneSettings;
  readonly due: number;
  /** Boards not started yet, in work order. */
  pending: SourceConfig[];
  deferred: Deferred[] = [];
  inFlight = new Map<string, number>();
  done = 0;
  failedPermanent = 0;
  stuck = 0;
  requests = 0;
  r429 = 0;
  errors: string[] = [];
  /** No new board starts before this (a Retry-After). */
  cooldownUntil = 0;
  completions: number[] = [];
  requestStamps: number[] = [];
  private cleanStreak = 0;
  private lastDecrease = -Infinity;
  private burst = 0;
  /** The largest gap at which a 429 still came: the gap never shrinks to within 25% of it. */
  private badGap = 0;
  private baseGap: number;
  private limiters = new Map<string, HostLimiter>();
  private floors: LaneDef["floors"];

  private tuning: Tuning;
  private emit: Emit;

  constructor(def: LaneDef, boards: SourceConfig[], tuning: Tuning, emit: Emit) {
    this.tuning = tuning;
    this.emit = emit;
    this.name = def.name;
    this.platforms = def.platforms;
    this.settings = { ...def.settings };
    this.baseGap = def.settings.gapMs;
    this.floors = def.floors;
    this.pending = boards;
    this.due = boards.length;
  }

  /** The host limiter for one platform: the lane's limits, tightened by the platform's own floor. */
  limiterFor(platform: string): HostLimiter {
    let limiter = this.limiters.get(platform);
    if (!limiter) {
      limiter = createHostLimiter(this.limitsFor(platform));
      this.limiters.set(platform, limiter);
    }
    return limiter;
  }

  private limitsFor(platform: string) {
    const floor = this.floors?.[platform];
    return {
      perHostConcurrency: Math.min(this.settings.perHost, floor?.perHost ?? Infinity),
      minHostIntervalMs: Math.max(this.settings.gapMs, floor?.gapMs ?? 0),
    };
  }

  /** Push the current perHost and gap into every limiter of the lane. */
  applyLimits(): void {
    for (const [platform, limiter] of this.limiters) limiter.setLimits(this.limitsFor(platform));
  }

  /** The owner sets a gap: it is also the floor AIMD shrinks back to. */
  setGap(gapMs: number): void {
    this.baseGap = gapMs;
    this.settings.gapMs = gapMs;
    this.applyLimits();
  }

  setConcurrency(n: number): void {
    this.settings.concurrency = n;
    if (n > this.settings.ceiling) this.settings.ceiling = n;
  }

  setCeiling(n: number): void {
    this.settings.ceiling = n;
    if (this.settings.concurrency > n) this.settings.concurrency = n;
  }

  /** Every response of the lane's hosts. A 429 reduces the lane; Retry-After holds it. */
  observe(status: number, retryAfterMs: number | undefined, now: number): void {
    this.requests++;
    this.requestStamps.push(now);
    if (status === 429) this.on429(retryAfterMs, now);
  }

  on429(retryAfterMs: number | undefined, now: number): void {
    this.r429++;
    this.burst++;
    this.cleanStreak = 0;
    if (retryAfterMs !== undefined)
      this.cooldownUntil = Math.max(
        this.cooldownUntil,
        now + Math.min(retryAfterMs, this.tuning.maxRetryAfterMs),
      );
    // One reduction per burst: a lane of 6 boards answers 429 six times at once.
    if (now - this.lastDecrease < this.tuning.decreaseWindowMs) return;
    this.lastDecrease = now;
    const s = this.settings;
    const gap = s.gapMs;
    this.badGap = Math.max(this.badGap, gap);
    // Geometric backoff. Without Retry-After the host gives no hint, so start high and learn downwards.
    const next =
      retryAfterMs !== undefined
        ? Math.max(gap * 2, this.tuning.retryAfterGapMs)
        : gap < this.tuning.noRetryAfterGapMs
          ? this.tuning.noRetryAfterGapMs
          : gap * 2;
    const before = s.concurrency;
    s.concurrency = Math.max(1, Math.floor(s.concurrency / 2));
    s.gapMs = Math.min(this.tuning.gapCapMs, next);
    this.applyLimits();
    const ra =
      retryAfterMs === undefined ? "" : `, Retry-After ${Math.round(retryAfterMs / 1000)} s`;
    this.emit(
      `${this.name}: 429 x${this.burst}${ra}, concurrency ${before} -> ${s.concurrency}, gap ${gap} -> ${s.gapMs} ms`,
    );
    this.burst = 0;
  }

  /** A board finished without trouble. After enough in a row, additive increase and a smaller gap. */
  onClean(): void {
    if (++this.cleanStreak < this.tuning.cleanBoards) return;
    this.cleanStreak = 0;
    const s = this.settings;
    const concurrency = Math.min(s.ceiling, s.concurrency + 1);
    const floor = Math.max(this.baseGap, Math.ceil(this.badGap * 1.25));
    let gap = s.gapMs > floor ? Math.max(floor, Math.floor(s.gapMs / 2)) : s.gapMs;
    if (gap > this.baseGap && gap < 250) gap = Math.max(this.baseGap, floor);
    if (concurrency === s.concurrency && gap === s.gapMs) return;
    this.emit(
      `${this.name}: ${this.tuning.cleanBoards} clean boards, concurrency ${s.concurrency} -> ${concurrency}, gap ${s.gapMs} -> ${gap} ms`,
    );
    s.concurrency = concurrency;
    s.gapMs = gap;
    this.applyLimits();
  }

  /** Backoff before attempt `attempts` + 1: exponential, jittered by up to 25% either way. */
  deferDelay(attempts: number, random: () => number): number {
    const slot = Math.min(this.tuning.deferCapMs, this.tuning.deferBaseMs * 2 ** (attempts - 1));
    return slot * (0.75 + random() * 0.5);
  }

  /** The next board to start: one whose deferral is over, else the next never-tried board. */
  take(now: number): { source: SourceConfig; attempts: number } | undefined {
    const i = this.deferred.findIndex((d) => d.notBefore <= now);
    if (i >= 0) {
      const [d] = this.deferred.splice(i, 1);
      return { source: d!.source, attempts: d!.attempts };
    }
    const source = this.pending.shift();
    return source ? { source, attempts: 0 } : undefined;
  }

  hasReady(now: number): boolean {
    return this.pending.length > 0 || this.deferred.some((d) => d.notBefore <= now);
  }

  get finished(): boolean {
    return !this.pending.length && !this.deferred.length && !this.inFlight.size;
  }

  note(error: string): void {
    this.errors = [error, ...this.errors].slice(0, 3);
  }

  /** Completions and requests in the last `windowMs`, per minute. */
  rates(now: number, startedAt: number, windowMs = 5 * 60_000) {
    const cut = now - windowMs;
    this.completions = this.completions.filter((t) => t >= cut);
    this.requestStamps = this.requestStamps.filter((t) => t >= cut);
    const minutes = Math.max(1 / 6, Math.min(windowMs, now - startedAt) / 60_000);
    return {
      boardsPerMin: this.completions.length / minutes,
      requestsPerMin: this.requestStamps.length / minutes,
    };
  }
}
