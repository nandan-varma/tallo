#!/usr/bin/env node
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import PQueue from "p-queue";
import pino from "pino";
import { createApi } from "./api.ts";
import { loadSources } from "./sources.ts";
import { syncSource } from "./sync.ts";
import { verifySource } from "./verify.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env file; environment variables may still be set.
}

const SOURCES_DIR = fileURLToPath(new URL("../../../sources", import.meta.url));
const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(process.stdout.isTTY ? { transport: { target: "pino-pretty" } } : {}),
});
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
  .option("-n, --limit <n>", "at most n sources", Number)
  .option("-c, --concurrency <n>", "sources in parallel", Number, 4)
  .option("--stale-hours <h>", "skip sources completed more recently than this", Number, 20)
  .action(async (opts) => {
    const api = createApi(need("TALLO_API_URL"), need("TALLO_INGEST_TOKEN"));
    const done = new Map((await api.sources()).map((s) => [s.id, s.lastCompleteRunAt ?? 0]));
    const cutoff = Date.now() / 1000 - opts.staleHours * 3600;
    let due = loadSources(SOURCES_DIR)
      .filter(
        (s) =>
          (!opts.platform || s.platform === opts.platform) &&
          (!opts.source || s.id === opts.source),
      )
      .filter((s) => opts.source || (done.get(s.id) ?? 0) < cutoff)
      .sort((a, b) => (done.get(a.id) ?? 0) - (done.get(b.id) ?? 0));
    if (opts.limit) due = due.slice(0, opts.limit);
    log.info({ due: due.length }, "starting sync");
    const queue = new PQueue({ concurrency: opts.concurrency });
    let failed = 0;
    await Promise.all(
      due.map((source) =>
        queue.add(async () => {
          try {
            const result = await syncSource(source, {
              api,
              log,
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
    log.info({ sources: due.length, incomplete: failed }, "sync finished");
  });

program
  .command("verify <source>")
  .description("Dry-run a source: list a sample, map it, report quality and unmapped fields")
  .option("-n, --sample <n>", "postings to sample", Number, 5)
  .option("--json", "machine-readable output")
  .action(async (id: string, opts) => {
    const result = await verifySource(pick(id), opts.sample);
    console.log(JSON.stringify(result, null, opts.json ? 0 : 2));
  });

program
  .command("reclassify")
  .description("Re-derive US/tech flags for jobs classified by older rules (no refetching)")
  .action(async () => {
    const api = createApi(need("TALLO_API_URL"), need("TALLO_INGEST_TOKEN"));
    let total = 0;
    for (;;) {
      const { updated, more } = await api.reclassify();
      total += updated;
      log.info({ updated, total }, "reclassified");
      if (!more) break;
    }
  });

program
  .command("sources")
  .description("List configured sources")
  .option("-p, --platform <id>")
  .action((opts) => {
    const sources = loadSources(SOURCES_DIR).filter(
      (s) => !opts.platform || s.platform === opts.platform,
    );
    const counts = Object.entries(Object.groupBy(sources, (s) => s.platform)).map(
      ([p, list]) => `${p}: ${list?.length}`,
    );
    console.log(`${sources.length} sources\n${counts.join("\n")}`);
  });

await program.parseAsync();
