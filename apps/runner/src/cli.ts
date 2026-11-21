#!/usr/bin/env node
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { createHostLimiter } from "@tallo/http";
import { Command, InvalidArgumentError } from "commander";
import PQueue from "p-queue";
import pino from "pino";
import { createApi } from "./api.ts";
import {
  CLOUD_STALE_HOURS,
  deadSources,
  dueSources,
  formatDead,
  LOCAL_EGRESS_STALE_HOURS,
  localEgressSources,
} from "./due.ts";
import { createPooledFetch } from "./net.ts";
import { createCpuPool, defaultThreads } from "./pool.ts";
import { loadHot, loadSources, retirableSourceIds } from "./sources.ts";
import { syncSource } from "./sync.ts";
import { verifySource } from "./verify.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env file; environment variables may still be set.
}

const SOURCES_DIR = fileURLToPath(new URL("../../../sources", import.meta.url));
/** The API's cap on configs per `POST /v1/admin/sources`. */
const REGISTER_CHUNK = 500;
const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(process.stdout.isTTY ? { transport: { target: "pino-pretty" } } : {}),
});
/** One rule for every numeric flag and env var: a finite number at or above `min`. Rejects NaN. */
const toNumber = (label: string, raw: string, min: number): number => {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < min)
    throw new Error(`${label} must be a number >= ${min}`);
  return value;
};
/** Commander argument parser for a numeric flag. Runs only when the flag is given. */
const numberFlag =
  (flag: string, min: number) =>
  (raw: string): number => {
    try {
      return toNumber(flag, raw, min);
    } catch (error) {
      throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
    }
  };
/** Env override read inside an action, so `tallo --help` never touches it. */
const envNumber = (name: string, min: number, fallback: number): number => {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : toNumber(name, raw, min);
};
const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};
const pick = (id: string) => {
  const source = loadSources(SOURCES_DIR).find((s) => s.id === id);
  if (!source) throw new Error(`Unknown source ${id}`);
  return source;
};

const program = new Command("tallo").description("Tallo collection runner");

program
  .command("sync")
  .description("Collect sources that are due and upload them")
  .option("-p, --platform <id>", "only this platform")
  .option("-s, --source <id>", "only this source, e.g. greenhouse:stripe")
  .option("-n, --limit <n>", "at most n sources", numberFlag("--limit", 1))
  .option(
    "--exclude-platform <id>",
    "skip this platform (repeatable; default: none excluded)",
    (id: string, previous: string[] = []) => [...previous, id],
  )
  .option(
    "-c, --concurrency <n>",
    "sources in parallel; stages of different boards overlap (default 16)",
    numberFlag("--concurrency", 1),
    16,
  )
  .option(
    "--threads <n>",
    "worker threads for hashing, HTML to text and gzip; 0 runs them on the main thread (env TALLO_THREADS, default min(4, cores-1))",
    numberFlag("--threads", 0),
  )
  .option(
    "--stale-hours <h>",
    `skip sources completed more recently than this (default ${CLOUD_STALE_HOURS}, or ${LOCAL_EGRESS_STALE_HOURS} with --local-egress)`,
    numberFlag("--stale-hours", 0),
  )
  .option(
    "--local-egress",
    'only boards with params.egress "local" (they need the Mac\'s network; the cloud never claims them)',
  )
  .option(
    "--per-host <n>",
    "max concurrent requests per host, shared by all sources (env TALLO_PER_HOST, default 8)",
    numberFlag("--per-host", 1),
  )
  .option(
    "--host-interval-ms <ms>",
    "min gap between request starts per host (env TALLO_HOST_INTERVAL_MS, default 0)",
    numberFlag("--host-interval-ms", 0),
  )
  .option("--include-dead", "also sync boards marked dead after repeated 404s")
  .action(async (opts) => {
    // Validate all knobs before any network call (api.sources, startRun).
    const concurrency = opts.concurrency as number;
    const perHost = (opts.perHost as number | undefined) ?? envNumber("TALLO_PER_HOST", 1, 8);
    const hostIntervalMs =
      (opts.hostIntervalMs as number | undefined) ?? envNumber("TALLO_HOST_INTERVAL_MS", 0, 0);
    const threads =
      (opts.threads as number | undefined) ?? envNumber("TALLO_THREADS", 0, defaultThreads());
    const net = createPooledFetch();
    const api = createApi(need("TALLO_API_URL"), need("TALLO_INGEST_TOKEN"), net.fetch);
    const state = new Map((await api.sources()).map((s) => [s.id, s]));
    const configured = loadSources(SOURCES_DIR);
    const staleHours =
      (opts.staleHours as number | undefined) ??
      (opts.localEgress ? LOCAL_EGRESS_STALE_HOURS : CLOUD_STALE_HOURS);
    const due = dueSources(opts.localEgress ? localEgressSources(configured) : configured, state, {
      ...(opts.platform ? { platform: opts.platform as string } : {}),
      ...(opts.excludePlatform ? { excludePlatforms: opts.excludePlatform as string[] } : {}),
      ...(opts.source ? { source: opts.source as string } : {}),
      includeDead: Boolean(opts.includeDead),
      cutoff: Date.now() / 1000 - staleHours * 3600,
      ...(opts.limit ? { limit: opts.limit as number } : {}),
    });
    log.info(
      { due: due.length, localEgress: Boolean(opts.localEgress), concurrency, threads },
      "starting sync",
    );
    const limiter = createHostLimiter({
      perHostConcurrency: perHost,
      minHostIntervalMs: hostIntervalMs,
    });
    const cpu = threads > 0 ? createCpuPool(threads) : undefined;
    const queue = new PQueue({ concurrency });
    let failed = 0;
    await Promise.all(
      due.map((source) =>
        queue.add(async () => {
          try {
            const result = await syncSource(source, {
              api,
              log,
              limiter,
              fetch: net.fetch,
              ...(cpu ? { cpu } : {}),
              runnerId: process.env.TALLO_RUNNER_ID ?? hostname(),
              version: process.env.npm_package_version ?? "dev",
            });
            if (!result.listingComplete) failed++;
          } catch (error) {
            failed++;
            log.error({ source: source.id, error: String(error) }, "sync failed");
          }
        }),
      ),
    );
    await cpu?.close();
    await net.close();
    log.info({ sources: due.length, incomplete: failed, threads }, "sync finished");
  });

program
  .command("verify <source>")
  .description("Dry-run a source: list a sample, map it, report quality and unmapped fields")
  .option("-n, --sample <n>", "postings to sample", numberFlag("--sample", 1), 5)
  .option("--json", "machine-readable output")
  .action(async (id: string, opts) => {
    const net = createPooledFetch();
    const result = await verifySource(pick(id), opts.sample, net.fetch).finally(() => net.close());
    console.log(JSON.stringify(result, null, opts.json ? 0 : 2));
  });

program
  .command("dedupe")
  .description(
    "Backfill duplicate keys for stored jobs, then regroup every posting (no refetching)",
  )
  .action(async () => {
    const api = createApi(need("TALLO_API_URL"), need("TALLO_INGEST_TOKEN"));
    let total = 0;
    let cursor = 0;
    for (;;) {
      const { updated, more, next } = await api.dedupeBackfill(cursor);
      total += updated;
      cursor = next;
      log.info({ updated, total }, "keyed");
      if (!more) break;
    }
    let after: string | undefined;
    for (;;) {
      const { keys, changed, next } = await api.dedupeRebuild(true, after);
      log.info({ keys, changed }, "regrouped");
      if (!next) break;
      after = next;
    }
  });

program
  .command("sources")
  .description("List configured sources, or the boards the server has marked dead")
  .option("-p, --platform <id>")
  .option("--dead", "list dead boards (from the server) instead of configured sources")
  .action(async (opts) => {
    if (opts.dead) {
      const api = createApi(need("TALLO_API_URL"), need("TALLO_INGEST_TOKEN"));
      const dead = deadSources(await api.sources()).filter(
        (s) => !opts.platform || s.id.startsWith(`${opts.platform}:`),
      );
      console.log(formatDead(dead));
      return;
    }
    const sources = loadSources(SOURCES_DIR).filter(
      (s) => !opts.platform || s.platform === opts.platform,
    );
    const counts = Object.entries(Object.groupBy(sources, (s) => s.platform)).map(
      ([p, list]) => `${p}: ${list?.length}`,
    );
    console.log(`${sources.length} sources\n${counts.join("\n")}`);
  });

program
  .command("revive <source...>")
  .description(
    "Clear the dead status and 404 count of boards marked dead by mistake; they are due again at once",
  )
  .action(async (ids: string[]) => {
    const configured = new Set(loadSources(SOURCES_DIR).map((s) => s.id));
    const unknown = ids.filter((id) => !configured.has(id));
    if (unknown.length) throw new Error(`Not in sources/: ${unknown.join(", ")}`);
    const api = createApi(need("TALLO_API_URL"), need("TALLO_INGEST_TOKEN"));
    const { revived } = await api.reviveSources(ids);
    const missing = ids.filter((id) => !revived.includes(id));
    log.info({ revived, ...(missing.length ? { missing } : {}) }, "revived");
  });

program
  .command("retire <source...>")
  .description(
    "Remove reviewed retired boards from the catalog; preserve historical runs and R2 objects",
  )
  .option("--dry-run", "preview affected sources, jobs and cleanup candidates without writing")
  .action(async (ids: string[], opts) => {
    const retired = retirableSourceIds(
      ids,
      loadSources(SOURCES_DIR).map((s) => s.id),
    );
    const dryRun = Boolean(opts.dryRun);
    const api = createApi(need("TALLO_API_URL"), need("TALLO_INGEST_TOKEN"));
    log.info(await api.retireSources(retired, dryRun), dryRun ? "retirement preview" : "retired");
  });

program
  .command("register")
  .description(
    "Send sources/*.json and sources/hot.json to the API (the Worker collects from them)",
  )
  .action(async () => {
    const api = createApi(need("TALLO_API_URL"), need("TALLO_INGEST_TOKEN"));
    const sources = loadSources(SOURCES_DIR);
    const hot = loadHot(SOURCES_DIR, sources);
    let registered = 0;
    // The API takes at most 500 configs per call; every call carries the whole hot list.
    for (let i = 0; i < sources.length; i += REGISTER_CHUNK) {
      const result = await api.registerSources(sources.slice(i, i + REGISTER_CHUNK), hot);
      registered += result.registered;
    }
    log.info({ sources: sources.length, hot: hot.length, registered }, "registered");
  });

await program.parseAsync();
