import type { Cpu } from "./cpu.ts";
import type { Ingest } from "./engine.ts";

/**
 * Where one board's time went, in milliseconds. Cheap: Date.now deltas and counters.
 *
 * Phase fields are cumulative busy time summed over concurrent tasks, so with parallel detail fetches they can
 * exceed `wallMs`; for a sequential board they add up to about `wallMs`. `limiterWaitMs` and `retryWaitMs` are
 * included inside `listMs` and `detailMs` (a request waits, then runs); readers subtract them to get the time
 * the source itself took.
 */
export interface Timings {
  /** Source listing requests, including the waits inside them. */
  listMs: number;
  /** startRun and the ingest diff call. */
  diffMs: number;
  /** Source detail requests (platform.detail), including the waits inside them. */
  detailMs: number;
  /** Hashing, map, HTML to text and gzip in the cpu hook (the worker pool on the Mac). */
  cpuMs: number;
  /** Ingest missingBlobs, jd, jobs and raw uploads. */
  uploadMs: number;
  finalizeMs: number;
  /** Time requests waited in the host limiter for a slot or a start gap. */
  limiterWaitMs: number;
  /** Time spent sleeping on Retry-After or backoff after a failed response. */
  retryWaitMs: number;
  sourceRequests: number;
  ingestCalls: number;
  /** Response body characters received from the source. */
  bytesIn: number;
  /** Elapsed time from start to finish of the run. */
  wallMs: number;
}

type Counters = Omit<Timings, "wallMs">;
/** The mutable accumulator the engine fills. */
export interface TimingMeter extends Counters {
  startedAt: number;
}

export const newMeter = (now = Date.now()): TimingMeter => ({
  listMs: 0,
  diffMs: 0,
  detailMs: 0,
  cpuMs: 0,
  uploadMs: 0,
  finalizeMs: 0,
  limiterWaitMs: 0,
  retryWaitMs: 0,
  sourceRequests: 0,
  ingestCalls: 0,
  bytesIn: 0,
  startedAt: now,
});

export function snapshot(meter: TimingMeter, now = Date.now()): Timings {
  const { startedAt, ...rest } = meter;
  return { ...rest, wallMs: now - startedAt };
}

/** Run `fn`, adding its elapsed time to `meter[key]`. A missing meter costs nothing. */
export async function timed<T>(
  meter: TimingMeter | undefined,
  key: "listMs" | "diffMs" | "detailMs" | "cpuMs" | "uploadMs" | "finalizeMs",
  fn: () => Promise<T>,
): Promise<T> {
  if (!meter) return fn();
  const start = Date.now();
  try {
    return await fn();
  } finally {
    meter[key] += Date.now() - start;
  }
}

/** The ingest, with each call timed into its phase and counted. */
export function meterIngest(ingest: Ingest, m: TimingMeter): Ingest {
  const wrap =
    <A extends unknown[], R>(
      key: "diffMs" | "uploadMs" | "finalizeMs",
      fn: (...args: A) => Promise<R>,
    ) =>
    (...args: A) => {
      m.ingestCalls++;
      return timed(m, key, () => fn(...args));
    };
  const metered: Ingest = {
    startRun: wrap("diffMs", (run) => ingest.startRun(run)),
    diffOrFinish: wrap("diffMs", (r, p, f) => ingest.diffOrFinish(r, p, f)),
    diff: wrap("diffMs", (r, p) => ingest.diff(r, p)),
    missingBlobs: wrap("uploadMs", (h) => ingest.missingBlobs(h)),
    putJd: wrap("uploadMs", (h, gz) => ingest.putJd(h, gz)),
    applyJobs: wrap("uploadMs", (r, j) => ingest.applyJobs(r, j)),
    putRaw: wrap("uploadMs", (r, gz) => ingest.putRaw(r, gz)),
    finalize: wrap("finalizeMs", (r, b) => ingest.finalize(r, b)),
  };
  return metered;
}

export function meterCpu(cpu: Cpu, m: TimingMeter): Cpu {
  return {
    hashes: (s, l) => timed(m, "cpuMs", () => cpu.hashes(s, l)),
    prepare: (s, p, h) => timed(m, "cpuMs", () => cpu.prepare(s, p, h)),
  };
}
