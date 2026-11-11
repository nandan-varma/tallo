import { readFileSync } from "node:fs";
import { gunzip } from "@tallo/catalog";
import type { Finalize, JobFacts, SourceConfig } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import {
  advance,
  begin,
  collectSource,
  complete,
  type EngineOptions,
  emptyProgress,
  type Ingest,
  loadPlan,
  memoryScratch,
  type Plan,
  type Progress,
  savePlan,
} from "../src/index.ts";

const fx = (name: string) =>
  readFileSync(new URL(`../../platforms/test/fixtures/${name}.json`, import.meta.url), "utf8");
const source: SourceConfig = {
  id: "greenhouse:stripe",
  platform: "greenhouse",
  key: "stripe",
  company: "Stripe",
  params: {},
};
const log = { info() {}, warn() {}, error() {} };

/** Fake Greenhouse: list from the fixture, details from the pay-transparency fixture. */
const fetchFake: typeof fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname.endsWith("/jobs")) return new Response(fx("greenhouse-list"));
  return new Response(fx("greenhouse-detail"));
};

function fakeIngest(over: Partial<Ingest> = {}) {
  const calls = {
    finalize: [] as Finalize[],
    applied: [] as JobFacts[],
    raw: [] as Uint8Array[],
  };
  const blobs = new Set<string>();
  const ingest: Ingest = {
    startRun: async () => undefined,
    diff: async (_runId, postings) => postings.map((p) => p.id),
    missingBlobs: async (hashes) => hashes.filter((h) => !blobs.has(h)),
    putJd: async (hash) => void blobs.add(hash),
    applyJobs: async (_runId, jobs) => {
      calls.applied.push(...jobs);
      return { applied: jobs.length, missingBlobs: [] };
    },
    putRaw: async (_runId, gz) => {
      calls.raw.push(gz);
      return "raw/greenhouse:stripe/run.ndjson.gz";
    },
    finalize: async (_runId, body) => {
      calls.finalize.push(body);
      return {
        status: body.listingComplete ? "complete" : "partial",
        closureApplied: false,
        closed: 0,
        reopened: 0,
      };
    },
    ...over,
  };
  return { ingest, calls };
}

const meta = { runId: "run-engine-0001", runnerId: "test", version: "t" };
const options = (ingest: Ingest, scratch = memoryScratch()): EngineOptions => ({
  ingest,
  scratch,
  log,
  fetch: fetchFake,
  detailConcurrency: 1,
});

describe("collectSource", () => {
  it("lists, maps and closes a complete run in one pass", async () => {
    const { ingest, calls } = fakeIngest();
    const result = await collectSource(source, meta, options(ingest));
    expect(result).toMatchObject({ listingComplete: true, detailsComplete: true, changed: 2 });
    expect(calls.finalize).toHaveLength(1);
    expect(calls.applied).toHaveLength(2);
    expect(calls.raw).toHaveLength(1);
  });
});

describe("slices", () => {
  it("resumes from the offset a stopped slice returns, and the raw pack holds every posting", async () => {
    const { ingest, calls } = fakeIngest();
    const scratch = memoryScratch();
    const opts = options(ingest, scratch);
    const begun = await begin(opts, { ...meta, source, startedAt: 1 });
    if (!("plan" in begun)) throw new Error("listing failed");
    const plan = begun.plan;
    expect(plan.changed).toHaveLength(2);

    // First slice: exactly one posting may start (concurrency 1), then stop.
    let checks = 0;
    const first = await advance(opts, plan, begun.progress, () => checks++ >= 1);
    expect(first.offset).toBe(1);
    expect(first.rawParts).toHaveLength(1);
    await expect(complete(opts, plan, first)).rejects.toThrow(/1 postings left/);

    const second = await advance(opts, plan, first);
    expect(second.offset).toBe(2);
    const outcome = await complete(opts, plan, second);
    expect(outcome).toMatchObject({ listingComplete: true, detailsComplete: true, changed: 2 });
    expect(calls.applied).toHaveLength(2);

    // Two raw parts, concatenated into one gzip stream that reads back as both postings.
    expect(calls.raw).toHaveLength(1);
    const lines = new TextDecoder()
      .decode(await gunzip(calls.raw[0]!))
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toHaveProperty("listing");
    // The parts are gone from scratch once the run is closed.
    expect(await scratch.get(`work/${meta.runId}/plan.json`)).toBeNull();
  });

  it("a plan survives the round trip through scratch (the Worker's continuation path)", async () => {
    const { ingest } = fakeIngest();
    const scratch = memoryScratch();
    const begun = await begin(options(ingest, scratch), { ...meta, source, startedAt: 1 });
    if (!("plan" in begun)) throw new Error("listing failed");
    await savePlan(scratch, begun.plan);
    const loaded: Plan = await loadPlan(scratch, meta.runId);
    expect(loaded.changed.map((c) => c.posting.id)).toEqual(
      begun.plan.changed.map((c) => c.posting.id),
    );
    expect(loaded.seenIds).toEqual(begun.plan.seenIds);
  });

  it("a failed apply leaves the offset where it was, so a retry does the same postings again", async () => {
    let fail = true;
    const { ingest, calls } = fakeIngest({
      applyJobs: async (_runId, jobs) => {
        if (fail) throw new Error("D1 unavailable");
        calls.applied.push(...jobs);
        return { applied: jobs.length, missingBlobs: [] };
      },
    });
    const opts = options(ingest);
    const begun = await begin(opts, { ...meta, source, startedAt: 1 });
    if (!("plan" in begun)) throw new Error("listing failed");
    const before: Progress = { ...begun.progress };
    await expect(advance(opts, begun.plan, before)).rejects.toThrow("D1 unavailable");
    // The caller still holds `before`; nothing was advanced, nothing was closed.
    expect(before.offset).toBe(0);
    expect(calls.finalize).toHaveLength(0);
    fail = false;
    const retried = await advance(opts, begun.plan, before);
    expect(retried.offset).toBe(2);
    expect(calls.applied).toHaveLength(2);
  });

  it("the stop check holds for a fresh progress: nothing starts, nothing is recorded", async () => {
    const { ingest, calls } = fakeIngest();
    const opts = options(ingest);
    const begun = await begin(opts, { ...meta, source, startedAt: 1 });
    if (!("plan" in begun)) throw new Error("listing failed");
    const none = await advance(opts, begun.plan, emptyProgress(), () => true);
    expect(none).toMatchObject({ offset: 0, rawParts: [] });
    expect(calls.applied).toHaveLength(0);
  });
});

describe("how the first request fails", () => {
  const firstFailure = (fetchImpl: typeof fetch) => {
    const { ingest } = fakeIngest();
    return begin({ ...options(ingest), fetch: fetchImpl }, { ...meta, source, startedAt: 1 });
  };

  it("a 404 on the first request says the board does not exist", async () => {
    const begun = await firstFailure(async () => new Response("", { status: 404 }));
    expect(begun).toMatchObject({
      finished: { listingComplete: false, boardNotFound: true, issues: [{ code: "http" }] },
    });
  });

  it("a redirect off the allowlist is a blocked run, never a board-not-found", async () => {
    const begun = await firstFailure(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://community.workday.com/retired" },
        }),
    );
    expect(begun).toMatchObject({
      finished: { listingComplete: false, boardNotFound: false, issues: [{ code: "blocked" }] },
    });
  });

  it("any other status is a plain failed run, not board-not-found", async () => {
    const begun = await firstFailure(async () => new Response("", { status: 400 }));
    expect(begun).toMatchObject({ finished: { boardNotFound: false, issues: [{ code: "http" }] } });
  });
});
