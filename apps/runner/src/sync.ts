import { randomUUID } from "node:crypto";
import { gzip, prepareJob, sha256, stableStringify } from "@tallo/catalog";
import type {
  CollectContext,
  Finalize,
  Issue,
  JobFacts,
  RawPosting,
  SourceConfig,
} from "@tallo/contracts";
import { createHttp, type HostLimiter, HttpError } from "@tallo/http";
import { platformFor } from "@tallo/platforms";
import PQueue from "p-queue";
import type { Logger } from "pino";
import type { Api } from "./api.ts";

export interface SyncOptions {
  api: Api;
  runnerId: string;
  version: string;
  log: Logger;
  /** Parallel detail fetches within one source. */
  detailConcurrency?: number;
  /** One limiter for the whole process, so per-host limits hold across parallel sources. */
  limiter?: HostLimiter;
  maxPostings?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

const BATCH = 100;
const now = () => Math.floor(Date.now() / 1000);

/** One source, one run: list, diff, fetch details for what changed, upload, finalize. */
export async function syncSource(
  source: SourceConfig,
  options: SyncOptions,
): Promise<Finalize & { changed: number }> {
  const { api, log } = options;
  const platform = platformFor(source);
  const runId = randomUUID();
  const startedAt = now();
  const issues: Issue[] = [];
  let requests = 0;

  const http = createHttp({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    allowedHosts: platform.hosts,
    ...(options.limiter ? { limiter: options.limiter } : {}),
    onRequest: () => void requests++,
  });
  const ctx: CollectContext = {
    http,
    maxPostings: options.maxPostings ?? 200_000,
    record: (i) => void issues.push(i),
  };

  await api.startRun({
    runId,
    source,
    runnerId: options.runnerId,
    collectorVersion: options.version,
    startedAt,
  });
  /** Close the run. Defaults describe a failed run: nothing complete, nothing inferred. */
  const finish = async (rest: Partial<Finalize>, changed = 0) => {
    const body: Finalize = {
      seenIds: [],
      listingComplete: false,
      detailsComplete: false,
      emptyIsAuthoritative: false,
      requests,
      finishedAt: now(),
      rawKey: null,
      issues: issues.slice(0, 50),
      boardNotFound: false,
      ...rest,
    };
    await api.finalize(runId, body);
    return { ...body, changed };
  };

  // 1. List. Any failure is a failed run: nothing is inferred about closures.
  const listed: RawPosting[] = [];
  let listing = { complete: false, emptyIsAuthoritative: false };
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
    issues.push({ code: "http", message: error instanceof Error ? error.message : String(error) });
    log.warn({ source: source.id, error: String(error) }, "listing failed");
    // A 404 means the board does not exist. Repeated 404s mark the source dead on the server.
    const boardNotFound = error instanceof HttpError && error.status === 404;
    return finish({ boardNotFound });
  }

  // 2. Which postings are new or changed? The fingerprint ignores volatile fields.
  const hashes = new Map<string, string>();
  for (const posting of listed) {
    const stable = platform.fingerprint?.(posting.listing) ?? posting.listing;
    hashes.set(posting.id, await sha256(stableStringify({ stable, platform: platform.version })));
  }
  const changedIds = new Set(
    await api.diff(
      runId,
      listed.map((p) => ({ id: p.id, hash: hashes.get(p.id)! })),
    ),
  );
  const changed = listed.filter((p) => changedIds.has(p.id));

  // 3. Details only for changed postings, then map and prepare.
  const prepared: { facts: JobFacts; jd: Uint8Array }[] = [];
  const raw: RawPosting[] = [];
  let detailsComplete = true;
  const queue = new PQueue({ concurrency: options.detailConcurrency ?? 6 });
  await Promise.all(
    changed.map((posting) =>
      queue.add(async () => {
        try {
          const full = platform.detail
            ? { ...posting, detail: await platform.detail(source, posting, ctx) }
            : posting;
          const mapped = platform.map(full, source);
          if (!mapped.title) throw new Error("Posting has no title");
          prepared.push(await prepareJob(mapped, source, hashes.get(posting.id)!));
          raw.push(full);
        } catch (error) {
          detailsComplete = false;
          issues.push({
            code: "detail",
            message: error instanceof Error ? error.message : String(error),
            postingId: posting.id,
          });
        }
      }),
    ),
  );

  // 4. Upload new description blobs, then apply jobs in batches.
  try {
    const missing = new Set(
      await api.missingBlobs([...new Set(prepared.map((p) => p.facts.jdHash))]),
    );
    const uploads = new PQueue({ concurrency: 8 });
    const byHash = new Map(prepared.map((p) => [p.facts.jdHash, p.jd]));
    await Promise.all(
      [...missing].map((hash) => uploads.add(() => api.putJd(hash, byHash.get(hash)!))),
    );
    for (let i = 0; i < prepared.length; i += BATCH) {
      const result = await api.applyJobs(
        runId,
        prepared.slice(i, i + BATCH).map((p) => p.facts),
      );
      if (result.missingBlobs.length)
        throw new Error(`Server still missing ${result.missingBlobs.length} blobs`);
    }
    const lines = raw.map((p) => JSON.stringify(p)).join("\n");
    const rawKey = raw.length
      ? await api.putRaw(runId, await gzip(new TextEncoder().encode(lines)))
      : null;
    const result = await finish(
      {
        seenIds: listed.map((p) => p.id),
        listingComplete: listing.complete,
        detailsComplete,
        emptyIsAuthoritative: listing.emptyIsAuthoritative,
        rawKey,
      },
      changed.length,
    );
    log.info(
      {
        source: source.id,
        listed: listed.length,
        changed: changed.length,
        detailsComplete,
        requests,
      },
      "synced",
    );
    return result;
  } catch (error) {
    issues.push({
      code: "http",
      message: `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    log.error({ source: source.id, error: String(error) }, "upload failed");
    return finish({ detailsComplete: false });
  }
}
