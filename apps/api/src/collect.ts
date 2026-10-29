import {
  advance,
  begin,
  type CollectMessage,
  complete,
  type EngineOptions,
  gatedLimiter,
  type Ingest,
  loadPlan,
  type Outcome,
  type Plan,
  type Progress,
  policyForHost,
  type Scratch,
  savePlan,
} from "@tallo/collect";
import type { BlobStore, Db } from "@tallo/db";
import {
  applyJobs,
  claimDue,
  claimSources,
  diff,
  finalize,
  IngestError,
  jdKey,
  sourceConfig,
  startRun,
  storeRawPack,
} from "@tallo/db";
import { createHostLimiter, type HostLimiter } from "@tallo/http";

/** Defaults for the knobs wrangler.jsonc sets as variables. */
export const DEFAULT_SLICE_SUBREQUESTS = 800;
export const DEFAULT_SLICE_MS = 5 * 60_000;
export const DEFAULT_BATCH = 40;

export interface CollectEnv {
  db: Db;
  blobs: BlobStore;
  /** The `tallo-collect` producer binding (or a fake in tests). */
  queue: {
    send(body: CollectMessage): Promise<unknown>;
    sendBatch(messages: { body: CollectMessage }[]): Promise<unknown>;
  };
  /** Reserve a start slot for a host; resolves with how long to wait (ms). Backed by the HostGate DO. */
  reserve: (host: string, gapMs: number) => Promise<number>;
  /** Kill switch: nothing is claimed or enqueued unless this is true. */
  enabled: boolean;
  sliceSubrequests: number;
  sliceMs: number;
  version: string;
  log: (line: Record<string, unknown>) => void;
  /** Injected in tests; production uses the global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}

const nowMs = (env: CollectEnv) => env.now?.() ?? Date.now();
const nowSeconds = (env: CollectEnv) => Math.floor(nowMs(env) / 1000);

/** The write side of ingest over the D1 and R2 bindings: the same functions the HTTP routes call. */
export function directIngest(db: Db, blobs: BlobStore): Ingest {
  return {
    startRun: (run) => startRun(db, run),
    diff: (runId, postings) => diff(db, runId, postings),
    missingBlobs: async (hashes) => {
      const absent = await Promise.all(
        hashes.map(async (h) => ((await blobs.has(jdKey(h))) ? null : h)),
      );
      return absent.filter((h): h is string => h !== null);
    },
    putJd: (hash, gz) => blobs.put(jdKey(hash), gz),
    applyJobs: (runId, jobs) => applyJobs(db, blobs, runId, jobs),
    putRaw: (runId, gz) => storeRawPack(db, blobs, runId, gz),
    finalize: (runId, body) => finalize(db, runId, body),
  };
}

interface Meter {
  subrequests: number;
}

/** Wrap a call so each one counts against the invocation's subrequest budget. */
function metered<A extends unknown[], R>(meter: Meter, fn: (...args: A) => R) {
  return (...args: A): R => {
    meter.subrequests++;
    return fn(...args);
  };
}

const outcomeOf = (o: Outcome) =>
  o.boardNotFound ? "not_found" : o.listingComplete ? "complete" : "partial";

/**
 * One queue message: start a board's run, or continue one. Work stops at the slice budget (subrequests
 * or wall time) and the rest goes back on the queue as a slice message. Closure happens only in the
 * final slice, and only from a complete listing (the engine guards that). Errors propagate so the queue
 * retries the message; a message that keeps failing lands in the dead-letter queue, and its run is
 * reaped as partial.
 */
export async function handleCollect(msg: CollectMessage, env: CollectEnv): Promise<void> {
  const started = nowMs(env);
  const meter: Meter = { subrequests: 0 };
  const base = createHostLimiter({ perHostConcurrency: (h) => policyForHost(h).concurrency });
  const counted: HostLimiter = {
    run: (host, task) => {
      meter.subrequests++;
      return base.run(host, task);
    },
  };
  const scratch: Scratch = {
    put: metered(meter, (key: string, bytes: Uint8Array) => env.blobs.put(key, bytes)),
    get: metered(meter, (key: string) => env.blobs.get(key)),
    delete: metered(meter, (key: string) => env.blobs.delete(key)),
  };
  const direct = directIngest(env.db, env.blobs);
  const options: EngineOptions = {
    ingest: {
      startRun: metered(meter, direct.startRun),
      diff: metered(meter, direct.diff),
      missingBlobs: metered(meter, direct.missingBlobs),
      putJd: metered(meter, direct.putJd),
      applyJobs: metered(meter, direct.applyJobs),
      putRaw: metered(meter, direct.putRaw),
      finalize: metered(meter, direct.finalize),
    },
    scratch,
    log: { info() {}, warn() {}, error() {} },
    now: () => nowSeconds(env),
    ...(env.fetch ? { fetch: env.fetch } : {}),
    limiter: gatedLimiter(
      counted,
      (host) => policyForHost(host).gapMs,
      async (host, gapMs) => {
        meter.subrequests++;
        const waitMs = await env.reserve(host, gapMs);
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      },
    ),
  };
  // The engine asks before each posting. The first ask always says go: a slice that spends its budget
  // on overhead (loading the plan, listing) must still make progress, or the run would loop forever.
  let asks = 0;
  const stop = () =>
    asks++ > 0 &&
    (meter.subrequests >= env.sliceSubrequests || nowMs(env) - started >= env.sliceMs);
  const line = (fields: Record<string, unknown>): void => {
    env.log({ wall_ms: nowMs(env) - started, subrequests: meter.subrequests, ...fields });
  };

  if (msg.kind === "slice") {
    const plan = await loadPlan(scratch, msg.runId);
    return resume(env, options, plan, msg.progress, stop, line);
  }

  const source = await sourceConfig(env.db, msg.sourceId);
  if (!source) return line({ source: msg.sourceId, outcome: "skipped", reason: "unknown source" });
  const fields = { source: source.id, platform: source.platform };
  let begun: Awaited<ReturnType<typeof begin>>;
  try {
    begun = await begin(options, {
      runId: msg.runId,
      source,
      runnerId: "worker",
      version: env.version,
      startedAt: nowSeconds(env),
    });
  } catch (error) {
    // Another run holds the board (the Mac runner, or an earlier message). Not a failure: ack it.
    if (error instanceof IngestError && error.status === 409)
      return line({ ...fields, outcome: "busy" });
    throw error;
  }
  if ("finished" in begun) {
    return line({
      ...fields,
      outcome: outcomeOf(begun.finished),
      requests: begun.finished.requests,
      listed: 0,
      changed: 0,
    });
  }
  await savePlan(scratch, begun.plan);
  return resume(env, options, begun.plan, begun.progress, stop, line);
}

async function resume(
  env: CollectEnv,
  options: EngineOptions,
  plan: Plan,
  progress: Progress,
  stop: () => boolean,
  line: (fields: Record<string, unknown>) => void,
): Promise<void> {
  const fields = { source: plan.source.id, platform: plan.source.platform };
  const next = await advance(options, plan, progress, stop);
  if (next.offset < plan.changed.length) {
    await env.queue.send({
      kind: "slice",
      sourceId: plan.source.id,
      runId: plan.runId,
      progress: next,
    });
    return line({
      ...fields,
      outcome: "continued",
      offset: next.offset,
      of: plan.changed.length,
      requests: next.requests,
    });
  }
  const outcome = await complete(options, plan, next);
  line({
    ...fields,
    outcome: outcomeOf(outcome),
    listed: plan.listed,
    changed: plan.changed.length,
    requests: next.requests,
    detailsComplete: next.detailsComplete,
  });
}

/** Queue a start message for each claimed board. The run id is chosen here, so a retry is idempotent. */
async function sendStarts(env: CollectEnv, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await env.queue.sendBatch(
    ids.map((sourceId) => ({ body: { kind: "start", sourceId, runId: crypto.randomUUID() } })),
  );
}

/**
 * Cron tick: claim up to `batch` due boards (one statement, leased for 30 minutes) and enqueue a
 * start message for each. Does nothing unless the kill switch is on.
 */
export async function enqueueDue(env: CollectEnv, batch: number): Promise<{ enqueued: number }> {
  if (!env.enabled) return { enqueued: 0 };
  const claimed = await claimDue(env.db, nowSeconds(env), batch);
  await sendStarts(
    env,
    claimed.map((s) => s.id),
  );
  return { enqueued: claimed.length };
}

/** Admin: collect named boards now, ignoring their due time. Returns the ids that were claimed. */
export async function enqueueNamed(
  env: CollectEnv,
  ids: string[],
): Promise<{ enqueued: string[] }> {
  if (!env.enabled) return { enqueued: [] };
  const claimed = (await claimSources(env.db, ids, nowSeconds(env))).map((s) => s.id);
  await sendStarts(env, claimed);
  return { enqueued: claimed };
}
