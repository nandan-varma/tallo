import { gunzip, gzip, PREPARE_VERSION, prepareJob, sha256, stableStringify } from "@tallo/catalog";
import type {
  CollectContext,
  CreateRun,
  Finalize,
  FinalizeResult,
  Issue,
  JobFacts,
  Listing,
  RawPosting,
  SourceConfig,
} from "@tallo/contracts";
import { createHostLimiter, createHttp, type HostLimiter, HttpError } from "@tallo/http";
import { platformFor } from "@tallo/platforms";
import PQueue from "p-queue";
import { policyFor } from "./policy.ts";

/**
 * The write side of ingest. The runner implements it over HTTP; the Worker implements it over the
 * D1 and R2 bindings. Both call the same `packages/db` ingest functions on the server side.
 */
export interface Ingest {
  startRun(run: CreateRun): Promise<unknown>;
  diff(runId: string, postings: { id: string; hash: string }[]): Promise<string[]>;
  missingBlobs(hashes: string[]): Promise<string[]>;
  putJd(hash: string, gz: Uint8Array): Promise<unknown>;
  applyJobs(runId: string, jobs: JobFacts[]): Promise<{ applied: number; missingBlobs: string[] }>;
  putRaw(runId: string, gz: Uint8Array): Promise<string>;
  finalize(runId: string, body: Finalize): Promise<FinalizeResult>;
}

/** Short-lived bytes that carry work between slices (R2 in the Worker, a Map in the runner). */
export interface Scratch {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export interface Log {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface EngineOptions {
  ingest: Ingest;
  scratch: Scratch;
  log: Log;
  /** Per-host limiter shared across sources. Default: a private one that honors each platform's policy. */
  limiter?: HostLimiter;
  /** Injected in tests. */
  fetch?: typeof fetch;
  maxPostings?: number;
  /** Parallel detail fetches. Default: the platform's policy concurrency. */
  detailConcurrency?: number;
}

/** What `begin` decided: the listing, the diff and the work that remains. Immutable once written. */
export interface Plan {
  runId: string;
  source: SourceConfig;
  runnerId: string;
  version: string;
  startedAt: number;
  listed: number;
  seenIds: string[];
  listing: Listing;
  changed: { posting: RawPosting; hash: string }[];
}

/** Counters and results carried from one slice to the next. Small enough for a queue message. */
export interface Progress {
  /** Index into `plan.changed` of the next posting to fetch. */
  offset: number;
  requests: number;
  issues: Issue[];
  detailsComplete: boolean;
  /** Scratch keys of the raw-pack parts written so far, in order. */
  rawParts: string[];
}

export type Outcome = Finalize & { changed: number };

/** Issues kept on the run row. */
export const ISSUE_CAP = 50;
const BATCH = 100;
const now = () => Math.floor(Date.now() / 1000);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const emptyProgress = (): Progress => ({
  offset: 0,
  requests: 0,
  issues: [],
  detailsComplete: true,
  rawParts: [],
});

export const planKey = (runId: string) => `work/${runId}/plan.json`;
const rawPartKey = (runId: string, offset: number) => `work/${runId}/raw-${offset}.ndjson.gz`;

export async function savePlan(scratch: Scratch, plan: Plan): Promise<void> {
  await scratch.put(planKey(plan.runId), new TextEncoder().encode(JSON.stringify(plan)));
}

export async function loadPlan(scratch: Scratch, runId: string): Promise<Plan> {
  const bytes = await scratch.get(planKey(runId));
  if (!bytes) throw new Error(`No plan stored for run ${runId}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as Plan;
}

function httpFor(source: SourceConfig, options: EngineOptions, counter: { requests: number }) {
  const platform = platformFor(source);
  return createHttp({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    allowedHosts: platform.hosts,
    limiter:
      options.limiter ??
      createHostLimiter({ perHostConcurrency: () => policyFor(platform.id).concurrency }),
    onRequest: () => void counter.requests++,
  });
}

/** Write the run's final body, closing it. Defaults describe a failed run: nothing complete, nothing inferred. */
async function finishRun(
  ingest: Ingest,
  runId: string,
  body: Finalize,
  changed = 0,
): Promise<Outcome> {
  await ingest.finalize(runId, body);
  return { ...body, changed };
}

/**
 * Start the run and list the board. Returns the plan (listing and diff) with fresh progress, or,
 * when the listing failed, the finished outcome: a failed run never closes anything.
 */
export async function begin(
  options: EngineOptions,
  meta: {
    runId: string;
    source: SourceConfig;
    runnerId: string;
    version: string;
    startedAt: number;
  },
): Promise<{ plan: Plan; progress: Progress } | { finished: Outcome }> {
  const { ingest, log } = options;
  const { runId, source } = meta;
  const platform = platformFor(source);
  const counter = { requests: 0 };
  const issues: Issue[] = [];
  const http = httpFor(source, options, counter);
  const ctx: CollectContext = {
    http,
    maxPostings: options.maxPostings ?? 200_000,
    record: (issue) => void issues.push(issue),
  };

  await ingest.startRun({
    runId,
    source,
    runnerId: meta.runnerId,
    collectorVersion: meta.version,
    startedAt: meta.startedAt,
  });

  // 1. List. Any failure is a failed run: nothing is inferred about closures.
  const listed: RawPosting[] = [];
  let listing: Listing = { complete: false, emptyIsAuthoritative: false };
  try {
    const gen = platform.list(source, ctx);
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        listing = next.value;
        break;
      }
      listed.push(next.value);
      if (listed.length >= ctx.maxPostings) {
        issues.push({ code: "budget", message: `Stopped at ${ctx.maxPostings} postings` });
        break;
      }
    }
  } catch (error) {
    issues.push({ code: "http", message: message(error) });
    log.warn({ source: source.id, error: String(error) }, "listing failed");
    // A 404 on the first request means the board does not exist; repeated ones mark it dead.
    // A 404 later in pagination is a failed run on a board that exists, so it must not count.
    // `requests` counts HTTP hops (retries of one hop are not counted), so any earlier request
    // makes this false. That is the safe direction: a board is only marked dead on a 404 that
    // was the very first request. A first hop redirected off the allowlist (a retired tenant
    // sent to a generic page) is the same signal: the board is no longer where the config says.
    const boardNotFound =
      error instanceof HttpError &&
      counter.requests === 1 &&
      (error.status === 404 || error.kind === "redirect");
    const finished = await finishRun(ingest, runId, {
      seenIds: [],
      listingComplete: false,
      detailsComplete: false,
      emptyIsAuthoritative: false,
      requests: counter.requests,
      finishedAt: now(),
      rawKey: null,
      issues: issues.slice(0, ISSUE_CAP),
      boardNotFound,
    });
    return { finished };
  }

  // 2. Which postings are new or changed? The fingerprint ignores volatile fields.
  const hashes = new Map<string, string>();
  for (const posting of listed) {
    const stable = platform.fingerprint?.(posting.listing) ?? posting.listing;
    // The prepare version is part of the hash so a catalog rule change re-prepares unchanged postings.
    const version = { platform: platform.version, prepare: PREPARE_VERSION };
    hashes.set(posting.id, await sha256(stableStringify({ stable, ...version })));
  }
  const changedIds = new Set(
    await ingest.diff(
      runId,
      listed.map((p) => ({ id: p.id, hash: hashes.get(p.id)! })),
    ),
  );
  const changed = listed
    .filter((p) => changedIds.has(p.id))
    .map((posting) => ({ posting, hash: hashes.get(posting.id)! }));

  const plan: Plan = {
    runId,
    source,
    runnerId: meta.runnerId,
    version: meta.version,
    startedAt: meta.startedAt,
    listed: listed.length,
    seenIds: listed.map((p) => p.id),
    listing,
    changed,
  };
  return {
    plan,
    progress: {
      ...emptyProgress(),
      requests: counter.requests,
      issues: issues.slice(0, ISSUE_CAP),
    },
  };
}

/**
 * Fetch, map and prepare the changed postings from `progress.offset`, then upload their
 * descriptions, apply the jobs, and write this slice's raw part. `stop` is checked before each
 * posting starts: once it returns true no new posting starts, and the returned offset says where
 * the next slice resumes. Postings are started in order, so the started ones are a prefix.
 * Throws when the upload or apply fails; the caller leaves the run running (the reaper closes it).
 */
export async function advance(
  options: EngineOptions,
  plan: Plan,
  progress: Progress,
  stop: () => boolean = () => false,
): Promise<Progress> {
  const { ingest } = options;
  const platform = platformFor(plan.source);
  const counter = { requests: progress.requests };
  const issues = [...progress.issues];
  let detailsComplete = progress.detailsComplete;
  const http = httpFor(plan.source, options, counter);
  const ctx: CollectContext = {
    http,
    maxPostings: options.maxPostings ?? 200_000,
    record: (issue) => void issues.push(issue),
  };

  // 3. Details only for changed postings, then map and prepare.
  const prepared: { facts: JobFacts; jd: Uint8Array }[] = [];
  const raw: RawPosting[] = [];
  let started = 0;
  const queue = new PQueue({
    concurrency: options.detailConcurrency ?? policyFor(platform.id).concurrency,
  });
  await Promise.all(
    plan.changed.slice(progress.offset).map(({ posting, hash }) =>
      queue.add(async () => {
        if (stop()) return;
        started++;
        try {
          const full = platform.detail
            ? { ...posting, detail: await platform.detail(plan.source, posting, ctx) }
            : posting;
          const mapped = platform.map(full, plan.source);
          if (!mapped.title) throw new Error("Posting has no title");
          prepared.push(await prepareJob(mapped, plan.source, hash));
          raw.push(full);
        } catch (error) {
          detailsComplete = false;
          issues.push({ code: "detail", message: message(error), postingId: posting.id });
        }
      }),
    ),
  );

  // 4. Upload new description blobs, then apply jobs in batches.
  if (prepared.length) {
    const missing = new Set(
      await ingest.missingBlobs([...new Set(prepared.map((p) => p.facts.jdHash))]),
    );
    const uploads = new PQueue({ concurrency: 8 });
    const byHash = new Map(prepared.map((p) => [p.facts.jdHash, p.jd]));
    await Promise.all(
      [...missing].map((hash) => uploads.add(() => ingest.putJd(hash, byHash.get(hash)!))),
    );
    for (let i = 0; i < prepared.length; i += BATCH) {
      const result = await ingest.applyJobs(
        plan.runId,
        prepared.slice(i, i + BATCH).map((p) => p.facts),
      );
      if (result.missingBlobs.length)
        throw new Error(`Server still missing ${result.missingBlobs.length} blobs`);
    }
  }

  const rawParts = [...progress.rawParts];
  if (raw.length) {
    const key = rawPartKey(plan.runId, progress.offset);
    // One newline-terminated line per posting, so parts join into valid ndjson.
    const lines = raw.map((p) => `${JSON.stringify(p)}\n`).join("");
    await options.scratch.put(key, await gzip(new TextEncoder().encode(lines)));
    rawParts.push(key);
  }
  return {
    offset: progress.offset + started,
    requests: counter.requests,
    issues: issues.slice(0, ISSUE_CAP),
    detailsComplete,
    rawParts,
  };
}

/**
 * Close the run once every changed posting has been attempted. The raw pack is the slice parts,
 * recompressed as one gzip stream.
 */
export async function complete(
  options: EngineOptions,
  plan: Plan,
  progress: Progress,
): Promise<Outcome> {
  if (progress.offset < plan.changed.length)
    throw new Error(`Run ${plan.runId} has ${plan.changed.length - progress.offset} postings left`);
  let rawKey: string | null = null;
  if (progress.rawParts.length) {
    const parts: Uint8Array[] = [];
    for (const key of progress.rawParts) {
      const bytes = await options.scratch.get(key);
      if (!bytes) throw new Error(`Missing raw part ${key}`);
      parts.push(bytes);
    }
    rawKey = await options.ingest.putRaw(plan.runId, await regzip(parts));
  }
  const body: Finalize = {
    seenIds: plan.seenIds,
    listingComplete: plan.listing.complete,
    detailsComplete: progress.detailsComplete,
    emptyIsAuthoritative: plan.listing.emptyIsAuthoritative,
    requests: progress.requests,
    finishedAt: now(),
    rawKey,
    issues: progress.issues.slice(0, ISSUE_CAP),
    boardNotFound: false,
  };
  const outcome = await finishRun(options.ingest, plan.runId, body, plan.changed.length);
  // Only after the run is closed: a retry of a failed finalize must still find its parts.
  for (const key of progress.rawParts) await options.scratch.delete(key);
  await options.scratch.delete(planKey(plan.runId));
  options.log.info(
    {
      source: plan.source.id,
      listed: plan.listed,
      changed: plan.changed.length,
      detailsComplete: progress.detailsComplete,
      requests: progress.requests,
    },
    "synced",
  );
  return outcome;
}

/**
 * One source, one run, start to finish in this process (the runner's path). The Worker drives
 * begin, advance and complete across invocations instead.
 */
export async function collectSource(
  source: SourceConfig,
  meta: { runId: string; runnerId: string; version: string },
  options: EngineOptions,
): Promise<Outcome> {
  const begun = await begin(options, { ...meta, source, startedAt: now() });
  if ("finished" in begun) return begun.finished;
  const { plan } = begun;
  try {
    const progress = await advance(options, plan, begun.progress);
    return await complete(options, plan, progress);
  } catch (error) {
    options.log.error({ source: source.id, error: String(error) }, "upload failed");
    return finishRun(options.ingest, plan.runId, {
      seenIds: [],
      listingComplete: false,
      detailsComplete: false,
      emptyIsAuthoritative: false,
      requests: begun.progress.requests,
      finishedAt: now(),
      rawKey: null,
      issues: [
        ...begun.progress.issues,
        { code: "http" as const, message: `Upload failed: ${message(error)}` },
      ].slice(0, ISSUE_CAP),
      boardNotFound: false,
    });
  }
}

/**
 * One gzip stream holding the parts' text, in order. Gzip members do not concatenate into a valid
 * stream for every reader (DecompressionStream rejects trailing members), so each part is inflated
 * and fed through a single compressor: one part of text is in memory at a time.
 */
async function regzip(parts: Uint8Array[]): Promise<Uint8Array> {
  if (parts.length === 1) return parts[0]!;
  const compressor = new CompressionStream("gzip");
  const writer = compressor.writable.getWriter();
  const feed = (async () => {
    for (const part of parts) await writer.write(new Uint8Array(await gunzip(part)));
    await writer.close();
  })();
  const [bytes] = await Promise.all([new Response(compressor.readable).arrayBuffer(), feed]);
  return new Uint8Array(bytes);
}
