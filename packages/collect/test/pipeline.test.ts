import { readFileSync } from "node:fs";
import type { JobFacts, SourceConfig } from "@tallo/contracts";
import { createHostLimiter } from "@tallo/http";
import { describe, expect, it } from "vitest";
import {
  type Cpu,
  collectSource,
  type EngineOptions,
  type Ingest,
  inThreadCpu,
  memoryScratch,
} from "../src/index.ts";

const fx = (name: string) =>
  readFileSync(new URL(`../../platforms/test/fixtures/${name}.json`, import.meta.url), "utf8");
const source: SourceConfig = {
  id: "bamboohr:big",
  platform: "bamboohr",
  key: "big",
  company: "Big",
  params: {},
};
const log = { info() {}, warn() {}, error() {} };
const POSTINGS = 250;
const meta = { runId: "run-pipeline-001", runnerId: "test", version: "t" };

/** A BambooHR board of POSTINGS postings (a thin list, a detail each); detail requests are recorded and answered after a tick. */
function board() {
  const template = JSON.parse(fx("bamboohr-list")).result[0];
  const result = Array.from({ length: POSTINGS }, (_, i) => ({
    ...template,
    id: String(1000 + i),
  }));
  const events: string[] = [];
  const fetchFake: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/careers/list"))
      return new Response(JSON.stringify({ meta: { totalCount: POSTINGS }, result }));
    events.push("detail");
    await new Promise((r) => setTimeout(r, 1));
    return new Response(fx("bamboohr-detail"));
  };
  return { events, fetchFake };
}

function ingestFor(events: string[], over: Partial<Ingest> = {}) {
  const applied: number[] = [];
  const finalized: { listingComplete: boolean; seenIds: string[] }[] = [];
  const ingest: Ingest = {
    startRun: async () => ({ validator: null }),
    async diffOrFinish(runId, postings, finish) {
      const changed = await this.diff(runId, postings);
      return changed.length
        ? { changed }
        : {
            changed,
            finalized: await this.finalize(runId, {
              ...finish,
              seenIds: postings.map((p) => p.id),
              rawKey: null,
            }),
          };
    },
    diff: async (_r, postings) => postings.map((p) => p.id),
    missingBlobs: async (hashes) => hashes,
    putJd: async () => undefined,
    applyJobs: async (_r, jobs: JobFacts[]) => {
      events.push("apply");
      applied.push(jobs.length);
      return { applied: jobs.length, ...{ invalid: [], bounded: [] }, missingBlobs: [] };
    },
    putRaw: async () => "raw/key",
    finalize: async (_r, body) => {
      finalized.push(body);
      return { status: "complete", closureApplied: false, closed: 0, reopened: 0 };
    },
    ...over,
  };
  return { ingest, applied, finalized };
}

const engine = (ingest: Ingest, fetchFake: typeof fetch, cpu?: Cpu): EngineOptions => ({
  ingest,
  scratch: memoryScratch(),
  log,
  fetch: fetchFake,
  limiter: createHostLimiter({ perHostConcurrency: 4 }),
  detailConcurrency: 4,
  ...(cpu ? { cpu } : {}),
});

describe("streamed upload", () => {
  it("applies in batches of 100 while later details are still being fetched", async () => {
    const { events, fetchFake } = board();
    const { ingest, applied } = ingestFor(events);
    const result = await collectSource(source, meta, engine(ingest, fetchFake));
    expect(result).toMatchObject({
      listingComplete: true,
      detailsComplete: true,
      changed: POSTINGS,
    });
    expect(applied).toEqual([100, 100, 50]);
    // Overlap: the first apply happens before the last detail has been requested.
    const firstApply = events.indexOf("apply");
    expect(events.slice(firstApply).filter((e) => e === "detail").length).toBeGreaterThan(0);
  });

  it("a failed apply fails the run: nothing complete, no closure", async () => {
    const { events, fetchFake } = board();
    let calls = 0;
    const { ingest, finalized } = ingestFor(events, {
      applyJobs: async (_r, jobs) => {
        if (++calls === 2) throw new Error("D1 unavailable");
        return { applied: jobs.length, ...{ invalid: [], bounded: [] }, missingBlobs: [] };
      },
    });
    const result = await collectSource(source, meta, engine(ingest, fetchFake));
    expect(result).toMatchObject({ listingComplete: false, detailsComplete: false });
    expect(result.issues.at(-1)?.message).toContain("D1 unavailable");
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({ listingComplete: false, seenIds: [] });
    // The failure stops new postings from starting; the rest are not all fetched for nothing.
    expect(events.filter((e) => e === "detail").length).toBeLessThan(POSTINGS);
  });
});

describe("cpu hook", () => {
  it("hashes in chunks and prepares every posting through the hook", async () => {
    const { events, fetchFake } = board();
    const { ingest, applied } = ingestFor(events);
    const seen = { hashes: [] as number[], prepare: 0 };
    const cpu: Cpu = {
      hashes: (s, listings) => {
        seen.hashes.push(listings.length);
        return inThreadCpu.hashes(s, listings);
      },
      prepare: (s, posting, hash) => {
        seen.prepare++;
        return inThreadCpu.prepare(s, posting, hash);
      },
    };
    await collectSource(source, meta, engine(ingest, fetchFake, cpu));
    expect(seen).toEqual({ hashes: [200, 50], prepare: POSTINGS });
    expect(applied.reduce((a, b) => a + b, 0)).toBe(POSTINGS);
  });

  it("a prepare that throws is a skipped posting, not a failed run", async () => {
    const { events, fetchFake } = board();
    const { ingest } = ingestFor(events);
    const cpu: Cpu = {
      hashes: inThreadCpu.hashes,
      prepare: async () => {
        throw new Error("Posting has no title");
      },
    };
    const result = await collectSource(source, meta, engine(ingest, fetchFake, cpu));
    expect(result).toMatchObject({ listingComplete: true, detailsComplete: false });
    expect(result.issues.filter((i) => i.code === "detail")).toHaveLength(50);
  });
});
