import type { SourceConfig } from "@tallo/contracts";
import { createHostLimiter, type HostLimiter, podKey } from "@tallo/http";
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
  /** 409 busy (another run holds the board): first delay, doubled, jittered, capped. Not counted in maxAttempts. */
  busyBaseMs: number;
  busyCapMs: number;
  /** How long a held board is retried, from its first 409: the run lease (2 h) plus a margin. */
  busyMaxMs: number;
  /** A host's gap after a 429 without Retry-After, and the clean requests that halve it. */
  hostFirstGapMs: number;
  hostCleanRequests: number;
  /** 429s on this many distinct hosts inside the window reduce a multi-host lane. */
  hostsToReduce: number;
  hostWindowMs: number;
  /** Clean requests in a row before perHost rises by one (while below its ceiling and not held down). */
  perHostCleanRequests: number;
  /** After a 429 halves perHost, it may not rise again for this long. */
  perHostHoldMs: number;
  /** A perHost that drew a 429 stays off limits (the cap is one below it) for this long. */
  perHostBadMs: number;
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
  busyBaseMs: 2 * 60_000,
  busyCapMs: 15 * 60_000,
  busyMaxMs: 130 * 60_000,
  hostFirstGapMs: 2000,
  hostCleanRequests: 10,
  hostsToReduce: 2,
  hostWindowMs: 60_000,
  perHostCleanRequests: 150,
  perHostHoldMs: 60_000,
  perHostBadMs: 30 * 60_000,
};

/** What a lane learned about its hosts, kept between sweeps in learned.json. */
export interface LearnedLane {
  /** Epoch ms of the last time the lane ran and wrote this. */
  at: number;
  perHost: number;
  gapMs: number;
  last429At: number | null;
  /** The perHost that drew a 429 (probing stays below it), or null. */
  perHostBad: number | null;
  hosts: Record<string, { gap: number; last429At: number }>;
}

/** The pod a board's requests go to, when its platform limits per pod (Workday, Oracle Cloud). */
export function boardGroup(source: SourceConfig): string | undefined {
  if (source.platform === "workday") {
    const wd = (source.params as Record<string, unknown> | undefined)?.wd;
    return typeof wd === "string" ? `${wd}.myworkdayjobs.com` : undefined;
  }
  if (source.platform === "oraclecloud") {
    const key = podKey(source.key);
    return key === source.key.toLowerCase() ? undefined : key;
  }
  return undefined;
}

interface HostState {
  /** Boards this pod may have in flight after its own 429s; 0 = the lane's perHost. */
  limit: number;
  cleanReq: number;
  r429: number;
  /** This host's own minimum request gap; 0 = none beyond the lane's. */
  gap: number;
  clean: number;
  last429: number;
  lastDecrease: number;
}

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
  private perHostClean = 0;
  private perHostHoldUntil = 0;
  private perHostBad = 0;
  private perHostBadAt = 0;
  private last429At = 0;
  /** Why perHost last changed: shown in status. */
  perHostWhy = "start";
  /** True when this sweep started from learned limits. */
  learned = false;
  private limiters = new Map<string, HostLimiter>();
  private hosts = new Map<string, HostState>();
  private groups = new Map<string, string>();
  private readonly multiHost: boolean;
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
    this.multiHost = def.multiHost === true;
    this.pending = boards;
    this.due = boards.length;
  }

  /** The host limiter for one platform: the lane's limits, tightened by the platform's own floor. */
  limiterFor(platform: string): HostLimiter {
    let limiter = this.limiters.get(platform);
    if (!limiter) {
      limiter = createHostLimiter({ ...this.limitsFor(platform), hostKey: podKey });
      for (const [host, h] of this.hosts) if (h.gap > 0) limiter.setHostInterval?.(host, h.gap);
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
  observe(status: number, retryAfterMs: number | undefined, now: number, host?: string): void {
    this.requests++;
    this.requestStamps.push(now);
    const key = host ? podKey(host) : undefined;
    if (status === 429) this.on429(retryAfterMs, now, key);
    else {
      if (key) this.onHostClean(key);
      this.maybeRaisePerHost(now);
    }
  }

  /** Per-host in-flight cap the lane may probe up to: its ceiling, and one below a value that drew a 429 lately. */
  private perHostCap(now: number): number {
    const s = this.settings;
    const bad = this.perHostBad > 0 && now - this.perHostBadAt < this.tuning.perHostBadMs;
    return bad ? Math.max(1, Math.min(s.perHostCeiling, this.perHostBad - 1)) : s.perHostCeiling;
  }

  /** Additive increase: +1 after enough clean requests, never past the cap, never during hold-down. */
  private maybeRaisePerHost(now: number): void {
    const s = this.settings;
    if (++this.perHostClean < this.tuning.perHostCleanRequests) return;
    if (now < this.perHostHoldUntil || s.perHost >= this.perHostCap(now)) return;
    this.perHostClean = 0;
    const before = s.perHost;
    s.perHost = before + 1;
    this.perHostWhy = `+1 after ${this.tuning.perHostCleanRequests} clean requests`;
    this.applyLimits();
    this.emit(`${this.name}: perHost ${before} -> ${s.perHost} (ceiling ${s.perHostCeiling})`);
  }

  /** Multiplicative decrease on a 429: halve (floor 1), hold down before probing up again. */
  private lowerPerHost(now: number): void {
    const s = this.settings;
    const before = s.perHost;
    this.perHostClean = 0;
    this.last429At = now;
    this.perHostHoldUntil = now + this.tuning.perHostHoldMs;
    if (before > 1) {
      this.perHostBad = before;
      this.perHostBadAt = now;
    }
    s.perHost = Math.max(1, Math.floor(before / 2));
    this.perHostWhy = `429 at ${before}, halved, held ${Math.round(this.tuning.perHostHoldMs / 1000)} s`;
    this.applyLimits();
  }

  /** Parallel detail fetches inside one board: follows perHost (and the platform's own cap), at most 8. */
  detailConcurrency(platform: string): number {
    const floor = this.floors?.[platform]?.perHost ?? Infinity;
    return Math.max(1, Math.min(this.settings.perHost, floor, 8));
  }

  /** The owner sets perHost directly; the ceiling follows if it is below. */
  setPerHost(n: number): void {
    this.settings.perHost = n;
    if (n > this.settings.perHostCeiling) this.settings.perHostCeiling = n;
    this.perHostWhy = "set by owner";
    this.applyLimits();
  }

  setPerHostCeiling(n: number): void {
    this.settings.perHostCeiling = n;
    if (this.settings.perHost > n) {
      this.settings.perHost = n;
      this.applyLimits();
    }
    this.perHostWhy = "ceiling set by owner";
  }

  /** What to persist; null when the lane made no request this sweep. */
  snapshot(now: number): LearnedLane | null {
    if (this.requests === 0) return null;
    const hosts: LearnedLane["hosts"] = {};
    for (const [host, h] of this.hosts)
      if (h.gap > 0 || h.last429 > 0)
        hosts[host] = { gap: h.gap, last429At: Math.max(0, h.last429) };
    return {
      at: now,
      perHost: this.settings.perHost,
      gapMs: this.settings.gapMs,
      last429At: this.last429At || null,
      perHostBad: this.perHostBad || null,
      hosts,
    };
  }

  /** Start from what an earlier sweep learned. The caller has already dropped stale entries. */
  applyLearned(l: LearnedLane, now: number): void {
    const s = this.settings;
    s.perHost = Math.max(1, Math.min(l.perHost, s.perHostCeiling));
    if (l.gapMs > s.gapMs) s.gapMs = l.gapMs;
    if (l.perHostBad) {
      this.perHostBad = l.perHostBad;
      this.perHostBadAt = l.last429At ?? l.at;
    }
    if (l.last429At) this.last429At = l.last429At;
    for (const [host, h] of Object.entries(l.hosts))
      this.hosts.set(host, {
        limit: 0,
        cleanReq: 0,
        r429: 0,
        gap: h.gap,
        clean: 0,
        last429: h.last429At || -Infinity,
        lastDecrease: -Infinity,
      });
    this.perHostWhy = `learned ${Math.round((now - l.at) / 60_000)} min ago`;
    this.learned = true;
    this.applyLimits();
  }

  /** Hosts with their own gap right now, and the largest of those gaps. */
  hostSlowdown(): { slowed: number; worstGapMs: number } {
    let slowed = 0;
    let worstGapMs = 0;
    for (const h of this.hosts.values())
      if (h.gap > 0) {
        slowed++;
        worstGapMs = Math.max(worstGapMs, h.gap);
      }
    return { slowed, worstGapMs };
  }

  private setHostGap(host: string, h: HostState, gap: number): void {
    h.gap = gap;
    for (const limiter of this.limiters.values()) limiter.setHostInterval?.(host, gap);
  }

  /** A clean response from a pod: after enough in a row its gap halves, then goes, and its board limit grows. */
  private onHostClean(host: string): void {
    const h = this.hosts.get(host);
    if (!h) return;
    if (h.limit > 0 && ++h.cleanReq >= this.tuning.perHostCleanRequests) {
      h.cleanReq = 0;
      h.limit = h.limit + 1 >= this.settings.perHost ? 0 : h.limit + 1;
    }
    if (h.gap === 0 || ++h.clean < this.tuning.hostCleanRequests) return;
    h.clean = 0;
    const half = Math.floor(h.gap / 2);
    this.setHostGap(host, h, half <= this.settings.gapMs || half < 250 ? 0 : half);
  }

  on429(retryAfterMs: number | undefined, now: number, rawHost?: string): void {
    const host = rawHost ? podKey(rawHost) : undefined;
    if (this.multiHost && host) {
      this.onHost429(retryAfterMs, now, host);
      return;
    }
    this.laneWide429(retryAfterMs, now);
  }

  /** A 429 on one host of a multi-host lane: slow that host; reduce the lane only when several hosts say so. */
  private onHost429(retryAfterMs: number | undefined, now: number, host: string): void {
    const t = this.tuning;
    let h = this.hosts.get(host);
    if (!h) {
      h = {
        limit: 0,
        cleanReq: 0,
        r429: 0,
        gap: 0,
        clean: 0,
        last429: -Infinity,
        lastDecrease: -Infinity,
      };
      this.hosts.set(host, h);
    }
    this.r429++;
    h.r429++;
    h.clean = 0;
    h.cleanReq = 0;
    h.last429 = now;
    if (now - h.lastDecrease >= t.decreaseWindowMs)
      h.limit = Math.max(1, Math.floor((h.limit || this.settings.perHost) / 2));
    if (now - h.lastDecrease >= t.decreaseWindowMs) {
      h.lastDecrease = now;
      const before = Math.max(h.gap, this.settings.gapMs);
      const next =
        retryAfterMs !== undefined
          ? Math.max(before * 2, Math.min(retryAfterMs, t.maxRetryAfterMs))
          : before < t.hostFirstGapMs
            ? t.hostFirstGapMs
            : before * 2;
      this.setHostGap(host, h, Math.min(t.gapCapMs, next));
      const ra =
        retryAfterMs === undefined ? "" : `, Retry-After ${Math.round(retryAfterMs / 1000)} s`;
      this.emit(`${this.name}: ${host} 429${ra}, host gap ${before} -> ${h.gap} ms`);
    }
    let recent = 0;
    for (const other of this.hosts.values()) if (now - other.last429 <= t.hostWindowMs) recent++;
    if (recent >= t.hostsToReduce) this.laneWide429(undefined, now, true);
  }

  /** `fromHosts`: several hosts said 429, so only concurrency drops; each host already has its own gap. */
  private laneWide429(retryAfterMs: number | undefined, now: number, fromHosts = false): void {
    if (!fromHosts) this.r429++;
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
    if (!fromHosts) s.gapMs = Math.min(this.tuning.gapCapMs, next);
    this.applyLimits();
    const perHostBefore = this.settings.perHost;
    this.lowerPerHost(now);
    const ra =
      retryAfterMs === undefined ? "" : `, Retry-After ${Math.round(retryAfterMs / 1000)} s`;
    this.emit(
      fromHosts
        ? `${this.name}: 429 on several hosts, concurrency ${before} -> ${s.concurrency}`
        : `${this.name}: 429 x${this.burst}${ra}, concurrency ${before} -> ${s.concurrency}, gap ${gap} -> ${s.gapMs} ms, perHost ${perHostBefore} -> ${s.perHost}`,
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

  /** Wait before busy retry `n` (1-based): 2 min doubling to a 15 min cap, jittered by up to 25%. */
  busyDelay(n: number, random: () => number): number {
    const slot = Math.min(this.tuning.busyCapMs, this.tuning.busyBaseMs * 2 ** (n - 1));
    return slot * (0.75 + random() * 0.5);
  }

  /** A board whose pod is full (its own limit) or in a gap hold-down with a board already running. */
  private blocked(source: SourceConfig): boolean {
    const g = boardGroup(source);
    if (!g) return false;
    let n = 0;
    for (const id of this.inFlight.keys()) if (this.groups.get(id) === g) n++;
    const h = this.hosts.get(g);
    if (n >= (h?.limit || this.settings.perHost)) return true;
    return !!h && h.gap > 0 && n >= 1;
  }

  /** The next board to start: a ready deferral, else the next never-tried board, skipping boards whose pod is busy. */
  take(now: number): { source: SourceConfig; attempts: number } | undefined {
    const i = this.deferred.findIndex((d) => d.notBefore <= now && !this.blocked(d.source));
    if (i >= 0) {
      const [d] = this.deferred.splice(i, 1);
      this.remember(d!.source);
      return { source: d!.source, attempts: d!.attempts };
    }
    const j = this.pending.findIndex((s) => !this.blocked(s));
    if (j < 0) return undefined;
    const [source] = this.pending.splice(j, 1);
    this.remember(source!);
    return { source: source!, attempts: 0 };
  }

  private remember(source: SourceConfig): void {
    const g = boardGroup(source);
    if (g) this.groups.set(source.id, g);
  }

  /** Per pod (a Workday wdN or Oracle pod): boards running, gap, board limit, 429s. */
  pods(): Record<string, { inFlight: number; gapMs: number; perHost: number; r429: number }> {
    const out: Record<string, { inFlight: number; gapMs: number; perHost: number; r429: number }> =
      {};
    const row = (g: string) => {
      const h = this.hosts.get(g);
      const existing = out[g];
      if (existing) return existing;
      const made = {
        inFlight: 0,
        gapMs: h?.gap ?? 0,
        perHost: h?.limit || this.settings.perHost,
        r429: h?.r429 ?? 0,
      };
      out[g] = made;
      return made;
    };
    for (const id of this.inFlight.keys()) {
      const g = this.groups.get(id);
      if (g) row(g).inFlight++;
    }
    for (const [g, h] of this.hosts) if (h.gap > 0 || h.r429 > 0) row(g);
    return out;
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
