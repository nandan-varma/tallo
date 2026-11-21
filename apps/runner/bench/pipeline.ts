/**
 * Offline benchmark of the runner pipeline: fixture-derived greenhouse boards, a fake network with fixed
 * latency, a fake ingest API with fixed latency. No real host is contacted.
 *
 *   node apps/runner/bench/pipeline.ts [--boards 200] [--postings 40] [--net-ms 15] [--api-ms 8]
 *                                      [--concurrency 16] [--threads 0]
 */
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import type { SourceConfig } from "@tallo/contracts";
import { createHostLimiter } from "@tallo/http";
import PQueue from "p-queue";
import { pino } from "pino";
import { syncSource } from "../src/sync.ts";

const { values } = parseArgs({
  options: {
    boards: { type: "string", default: "200" },
    postings: { type: "string", default: "40" },
    "net-ms": { type: "string", default: "15" },
    "api-ms": { type: "string", default: "8" },
    concurrency: { type: "string", default: "16" },
    // One host in this bench stands for several in production (8 per host), so the default is 8 hosts' worth.
    "per-host": { type: "string", default: "64" },
    threads: { type: "string", default: "0" },
  },
});
const boards = Number(values.boards);
const postings = Number(values.postings);
const netMs = Number(values["net-ms"]);
const apiMs = Number(values["api-ms"]);
const concurrency = Number(values.concurrency);
const threads = Number(values.threads);
const perHost = Number(values["per-host"]);
const limiter = createHostLimiter({ perHostConcurrency: perHost });

const fx = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/platforms/test/fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const listTemplate = fx("greenhouse-list").jobs[0];
const detailTemplate = fx("greenhouse-detail");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Each posting differs in id and text, so nothing dedupes away. Pure string work: cheap on the main thread. */
const listJson = JSON.stringify(listTemplate);
const detailJson = JSON.stringify(detailTemplate);
const listing = (board: number) =>
  `{"jobs":[${Array.from({ length: postings }, (_, i) => {
    const id = board * 10_000 + i;
    return listJson.replace(/"id":\d+/, `"id":${id}`).replaceAll("Stripe", `Co${id}`);
  }).join(",")}]}`;
// 64 distinct bodies, reused: the bench's own string work must not compete with the code under test.
const details = Array.from({ length: 64 }, (_, n) =>
  detailJson.replace(/"id":\d+/, `"id":${n}`).replaceAll("Stripe", `Co${n}`),
);
const detail = (id: string) => details[Number(id) % 64] as string;

const fakeFetch: typeof fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  await sleep(netMs);
  const parts = url.pathname.split("/");
  if (url.pathname.endsWith("/jobs")) return new Response(listing(Number(parts[3]?.slice(1))));
  return new Response(detail(parts.at(-1) ?? "0"));
};

let calls = 0;
const api = new Proxy(
  {},
  {
    get:
      (_t, name: string) =>
      async (...args: unknown[]) => {
        calls++;
        await sleep(apiMs);
        switch (name) {
          case "diff":
            return (args[1] as { id: string }[]).map((p) => p.id);
          case "missingBlobs":
            return args[0];
          case "applyJobs":
            return { applied: (args[1] as unknown[]).length, missingBlobs: [] };
          case "putRaw":
            return "raw/x";
          default:
            return {};
        }
      },
  },
) as never;

const sources: SourceConfig[] = Array.from({ length: boards }, (_, b) => ({
  id: `greenhouse:b${b}`,
  platform: "greenhouse",
  key: `b${b}`,
  company: `Board ${b}`,
  params: {},
}));

const pool = threads > 0 ? await import("../src/pool.ts") : undefined;
const cpu = pool?.createCpuPool(threads);
const delay = monitorEventLoopDelay({ resolution: 5 });
delay.enable();
const elu0 = performance.eventLoopUtilization();
const t0 = performance.now();
const queue = new PQueue({ concurrency });
let changed = 0;
await Promise.all(
  sources.map((source) =>
    queue.add(async () => {
      const result = await syncSource(source, {
        api,
        log: pino({ level: "silent" }),
        runnerId: "bench",
        version: "bench",
        fetch: fakeFetch,
        limiter,
        detailConcurrency: 8,
        ...(cpu ? { cpu } : {}),
      });
      changed += result.changed;
    }),
  ),
);
const wall = performance.now() - t0;
const elu = performance.eventLoopUtilization(elu0);
await cpu?.close();
console.log(
  JSON.stringify({
    boards,
    postings,
    netMs,
    apiMs,
    concurrency,
    perHost,
    threads,
    jobs: changed,
    apiCalls: calls,
    wallSec: +(wall / 1000).toFixed(2),
    jobsPerSec: Math.round(changed / (wall / 1000)),
    mainThreadBusy: +elu.utilization.toFixed(2),
    loopDelayP99Ms: +(delay.percentile(99) / 1e6).toFixed(1),
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
  }),
);
