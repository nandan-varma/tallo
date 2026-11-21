import type { CollectMessage } from "@tallo/collect";
import type { BlobStore } from "@tallo/db";
import {
  pruneRuns,
  purgeClosed,
  reapStaleRuns,
  rebuildDuplicates,
  repairSchedule,
  schema,
} from "@tallo/db";
import { drizzle } from "drizzle-orm/d1";
import { createApp } from "./app.ts";
import {
  type CollectEnv,
  DEFAULT_BATCH,
  DEFAULT_SLICE_MS,
  DEFAULT_SLICE_SUBREQUESTS,
  enqueueDue,
  handleCollect,
} from "./collect.ts";
import type { HostGate } from "./host-gate.ts";
import { housekeeping } from "./housekeeping.ts";
import { meterD1 } from "./meter.ts";

export { HostGate } from "./host-gate.ts";

/** Every five minutes the cron claims due boards and enqueues them (when COLLECT_ENABLED is "1"). */
// Not exported: a Worker entry module may export only handlers and classes.
const COLLECT_CRON = "*/5 * * * *";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  INGEST_TOKEN: string;
  /** Host the public reads are refused on: the API's public custom domain. Unset: allowed (tests, local dev). */
  READS_BLOCKED_HOST?: string;
  COLLECT: Queue<CollectMessage>;
  HOST_GATE: DurableObjectNamespace<HostGate>;
  /** Kill switch. Anything other than "1" means the cron enqueues nothing. */
  COLLECT_ENABLED?: string;
  /** Boards claimed per cron tick. */
  COLLECT_BATCH?: string;
  /** Subrequest budget per queue invocation before it hands off a slice. */
  COLLECT_SLICE_SUBREQUESTS?: string;
  /** Wall-time budget per queue invocation (ms) before it hands off a slice. */
  COLLECT_SLICE_MS?: string;
}

const r2 = (bucket: R2Bucket): BlobStore => ({
  has: async (key) => (await bucket.head(key)) !== null,
  put: async (key, bytes) => void (await bucket.put(key, bytes)),
  get: async (key) => {
    const object = await bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  },
  delete: (key) => bucket.delete(key),
});

/** A whole non-negative integer from a variable, or the default when unset or malformed. */
const intVar = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 1 ? n : fallback;
};

const collectEnv = (env: Env): CollectEnv => ({
  db: drizzle(env.DB, { schema }),
  blobs: r2(env.BLOBS),
  queue: env.COLLECT,
  reserve: (host, gapMs, count) =>
    env.HOST_GATE.get(env.HOST_GATE.idFromName(host)).reserve(gapMs, count),
  enabled: env.COLLECT_ENABLED === "1",
  sliceSubrequests: intVar(env.COLLECT_SLICE_SUBREQUESTS, DEFAULT_SLICE_SUBREQUESTS),
  sliceMs: intVar(env.COLLECT_SLICE_MS, DEFAULT_SLICE_MS),
  version: "worker-1",
  log: (line) => console.log(JSON.stringify(line)),
});

const deps = (env: Env) => ({
  db: drizzle(meterD1(env.DB), { schema }),
  blobs: r2(env.BLOBS),
  ingestToken: env.INGEST_TOKEN,
  readsBlockedHost: env.READS_BLOCKED_HOST,
  collect: collectEnv(env),
});

// The env object is stable for the life of an isolate, so build the app once per env.
const apps = new WeakMap<Env, ReturnType<typeof createApp>>();
const appFor = (env: Env) => {
  const cached = apps.get(env);
  if (cached) return cached;
  const app = createApp(deps(env));
  apps.set(env, app);
  return app;
};

export default {
  fetch: (request, env, ctx) => appFor(env).fetch(request, env, ctx),
  /**
   * The five-minute cron enqueues due boards. The hourly one does housekeeping: mark runs abandoned
   * by a killed collector as partial, drop jobs closed for 30+ days and their orphaned description
   * blobs, regroup duplicate postings, and bring back into the schedule any board stranded far in the future.
   */
  async scheduled(event: ScheduledController, env: Env) {
    if (event.cron === COLLECT_CRON) {
      await enqueueDue(collectEnv(env), intVar(env.COLLECT_BATCH, DEFAULT_BATCH));
      return;
    }
    const { db, blobs } = deps(env);
    await housekeeping(
      {
        reapStaleRuns: () => reapStaleRuns(db),
        repairSchedule: () => repairSchedule(db),
        // Default 30 days and the wall clock; `limit` bounds the subrequests this invocation spends.
        purgeClosed: (limit) => purgeClosed(db, blobs, undefined, undefined, limit),
        pruneRuns: () => pruneRuns(db, blobs),
        regroupPage: (after) => rebuildDuplicates(db, undefined, { after }),
      },
      (event) => console.error(JSON.stringify({ job: "hourly", ...event })),
    );
  },
  /** One board per invocation (batch size 1). A failed message is retried, then dead-lettered. */
  async queue(batch: MessageBatch<CollectMessage>, env: Env) {
    const collect = collectEnv(env);
    for (const message of batch.messages) {
      try {
        await handleCollect(message.body, collect);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            source: message.body.sourceId,
            outcome: "error",
            error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          }),
        );
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, CollectMessage>;
