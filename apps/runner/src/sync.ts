import { randomUUID } from "node:crypto";
import {
  type Cpu,
  collectSource,
  type EngineOptions,
  type Log,
  memoryScratch,
  type Outcome,
} from "@tallo/collect";
import type { SourceConfig } from "@tallo/contracts";
import type { HostLimiter } from "@tallo/http";
import type { Logger } from "pino";
import type { Api } from "./api.ts";

interface SyncOptions {
  api: Api;
  runnerId: string;
  version: string;
  log: Logger;
  /** Parallel detail fetches within one source. */
  detailConcurrency?: number;
  /** One limiter for the whole process, so per-host limits hold across parallel sources. */
  limiter?: HostLimiter;
  maxPostings?: number;
  /** CPU hook: a worker-thread pool in the CLI, this thread when absent (tests). */
  cpu?: Cpu;
  /** Injected in tests. */
  fetch?: typeof fetch;
  retryDelay?: (attempt: number) => number;
}

/** One source, one run: list, diff, fetch details for what changed, upload, finalize. */
export async function syncSource(source: SourceConfig, options: SyncOptions): Promise<Outcome> {
  const engine: EngineOptions = {
    ingest: options.api,
    scratch: memoryScratch(),
    log: options.log as Log,
    ...(options.limiter ? { limiter: options.limiter } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.retryDelay ? { retryDelay: options.retryDelay } : {}),
    ...(options.cpu ? { cpu: options.cpu } : {}),
    ...(options.maxPostings ? { maxPostings: options.maxPostings } : {}),
    ...(options.detailConcurrency ? { detailConcurrency: options.detailConcurrency } : {}),
  };
  return collectSource(
    source,
    { runId: randomUUID(), runnerId: options.runnerId, version: options.version },
    engine,
  );
}
