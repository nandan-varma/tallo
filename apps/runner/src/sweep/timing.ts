import type { Timings } from "@tallo/collect";

/** The five places a board's time goes. Shares add up to 1 (or all 0 with no data). */
export interface Shares {
  source: number;
  limiterWait: number;
  cpu: number;
  ingest: number;
  retryWait: number;
}
export type Bottleneck = keyof Shares;

interface Sums {
  boards: number;
  wallMs: number;
  source: number;
  limiterWait: number;
  cpu: number;
  ingest: number;
  retryWait: number;
  sourceRequests: number;
  ingestCalls: number;
  bytesIn: number;
}
const empty = (): Sums => ({
  boards: 0,
  wallMs: 0,
  source: 0,
  limiterWait: 0,
  cpu: 0,
  ingest: 0,
  retryWait: 0,
  sourceRequests: 0,
  ingestCalls: 0,
  bytesIn: 0,
});

/** `listMs` and `detailMs` include the waits inside them: what is left is the source itself. */
function addTo(sums: Sums, t: Timings, wallMs: number): void {
  const waits = t.limiterWaitMs + t.retryWaitMs;
  sums.boards++;
  sums.wallMs += wallMs;
  sums.source += Math.max(0, t.listMs + t.detailMs - waits);
  sums.limiterWait += t.limiterWaitMs;
  sums.cpu += t.cpuMs;
  sums.ingest += t.diffMs + t.uploadMs + t.finalizeMs;
  sums.retryWait += t.retryWaitMs;
  sums.sourceRequests += t.sourceRequests;
  sums.ingestCalls += t.ingestCalls;
  sums.bytesIn += t.bytesIn;
}

export function sharesOf(s: Sums): Shares {
  const total = s.source + s.limiterWait + s.cpu + s.ingest + s.retryWait;
  const f = (n: number) => (total > 0 ? n / total : 0);
  return {
    source: f(s.source),
    limiterWait: f(s.limiterWait),
    cpu: f(s.cpu),
    ingest: f(s.ingest),
    retryWait: f(s.retryWait),
  };
}

export const dominant = (shares: Shares): Bottleneck | null => {
  const [top] = (Object.entries(shares) as [Bottleneck, number][]).sort((a, b) => b[1] - a[1]);
  return top && top[1] > 0 ? top[0] : null;
};

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const WALLS_KEPT = 500;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Per-lane aggregate of board timings: totals for status, a window that resets for the periodic event. */
export class LaneTimings {
  private total = empty();
  private window = empty();
  private walls: number[] = [];

  record(t: Timings | undefined, wallMs = t?.wallMs ?? 0): void {
    if (!t) return;
    addTo(this.total, t, wallMs);
    addTo(this.window, t, wallMs);
    this.walls.push(wallMs);
    if (this.walls.length > WALLS_KEPT) this.walls.shift();
  }

  summary() {
    const s = this.total;
    const shares = sharesOf(s);
    const wallSec = s.wallMs / 1000;
    return {
      boards: s.boards,
      shares: {
        source: r3(shares.source),
        limiterWait: r3(shares.limiterWait),
        cpu: r3(shares.cpu),
        ingest: r3(shares.ingest),
        retryWait: r3(shares.retryWait),
      },
      wallP50Ms: Math.round(percentile(this.walls, 50)),
      wallP90Ms: Math.round(percentile(this.walls, 90)),
      /** Source requests per second of board wall time: how hard one board drives its host. */
      requestsPerSecPerBoard:
        wallSec > 0 ? Math.round((s.sourceRequests / wallSec) * 100) / 100 : 0,
      sourceRequests: s.sourceRequests,
      ingestCalls: s.ingestCalls,
      bytesIn: s.bytesIn,
    };
  }

  /** The dominant sink of boards finished since the last call, or null when there were none. */
  takeWindow(): { shares: Shares; boards: number; top: Bottleneck } | null {
    const w = this.window;
    this.window = empty();
    const shares = sharesOf(w);
    const top = dominant(shares);
    return w.boards > 0 && top ? { shares, boards: w.boards, top } : null;
  }
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** `source 61%, limiter wait 22%, cpu 6%, ingest 9%, retry waits 2%` */
export const sharesLine = (s: Shares) =>
  `source ${pct(s.source)}, limiter wait ${pct(s.limiterWait)}, cpu ${pct(s.cpu)}, ingest ${pct(s.ingest)}, retry waits ${pct(s.retryWait)}`;

/** The sentence the controller logs every few minutes: what dominates a lane and what to try. */
export function bottleneckMessage(
  lane: string,
  top: Bottleneck,
  shares: Shares,
  perHost: number,
): string {
  const p = pct(shares[top]);
  switch (top) {
    case "limiterWait":
      return `${lane}: ${p} of time waiting on the host limiter (perHost ${perHost}): room to raise perHost`;
    case "source":
      return `${lane}: ${p} of time in source responses: the host is the limit, more boards in parallel may help`;
    case "retryWait":
      return `${lane}: ${p} of time sleeping on retries: the host is throttling, lower the rate`;
    case "cpu":
      return `${lane}: ${p} of time in cpu (html to text, hashing, gzip): the worker pool is the limit`;
    case "ingest":
      return `${lane}: ${p} of time in the ingest API: uploads are the limit`;
  }
}
