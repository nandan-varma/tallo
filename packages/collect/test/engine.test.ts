import { readFileSync } from "node:fs";
import { gunzip } from "@tallo/catalog";
import type { Finalize, JobFacts, SourceConfig } from "@tallo/contracts";
import { createHostLimiter } from "@tallo/http";
import { describe, expect, it } from "vitest";
import {
  advance,
  begin,
  collectSource,
  complete,
  type EngineOptions,
  emptyProgress,
  type Ingest,
  inThreadCpu,
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
    startRun: async () => ({ validator: null }),
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

describe("timings", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // BambooHR: a thin list and one detail request per posting, so the limiter and detail phases both have work.
  const bamboo: SourceConfig = {
    id: "bamboohr:small",
    platform: "bamboohr",
    key: "small",
    company: "Small",
    params: {},
  };
  const template = JSON.parse(fx("bamboohr-list")).result[0];
  const result = [1, 2, 3].map((i) => ({ ...template, id: String(1000 + i) }));
  const slowFetch: typeof fetch = async (input) => {
    await sleep(20);
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.pathname.endsWith("/careers/list")
      ? new Response(JSON.stringify({ meta: { totalCount: 3 }, result }))
      : new Response(fx("bamboohr-detail"));
  };

  it("splits a sequential board's wall time into phases that add up", async () => {
    const { ingest } = fakeIngest({
      diff: async (_r, postings) => {
        await sleep(25);
        return postings.map((p) => p.id);
      },
      applyJobs: async (_r, jobs) => {
        await sleep(15);
        return { applied: jobs.length, missingBlobs: [] };
      },
      finalize: async () => {
        await sleep(10);
        return { status: "complete", closureApplied: false, closed: 0, reopened: 0 };
      },
    });
    const started = Date.now();
    const done = await collectSource(bamboo, meta, { ...options(ingest), fetch: slowFetch });
    const wall = Date.now() - started;
    const t = done.timings!;
    expect(t.sourceRequests).toBe(4);
    expect(t.listMs).toBeGreaterThanOrEqual(18);
    expect(t.detailMs).toBeGreaterThanOrEqual(58);
    expect(t.diffMs).toBeGreaterThanOrEqual(24);
    expect(t.finalizeMs).toBeGreaterThanOrEqual(9);
    expect(t.uploadMs).toBeGreaterThanOrEqual(14);
    // start, diff, jobs, raw, finalize: no blob check (204 applies first and only checks missing descriptions).
    expect(t.ingestCalls).toBeGreaterThanOrEqual(5);
    expect(t.bytesIn).toBeGreaterThan(0);
    const parts = t.listMs + t.diffMs + t.detailMs + t.cpuMs + t.uploadMs + t.finalizeMs;
    expect(parts).toBeLessThanOrEqual(wall + 5);
    expect(parts).toBeGreaterThanOrEqual(wall * 0.8);
    expect(t.wallMs).toBeGreaterThanOrEqual(parts - 5);
  });

  it("counts time spent waiting in the host limiter", async () => {
    const { ingest } = fakeIngest();
    const limiter = createHostLimiter({ perHostConcurrency: 1, minHostIntervalMs: 30 });
    const done = await collectSource(bamboo, meta, {
      ...options(ingest),
      fetch: slowFetch,
      limiter,
    });
    // Four requests, each start 30 ms after the last: the waiting is the gap beyond the previous request.
    expect(done.timings!.limiterWaitMs).toBeGreaterThanOrEqual(1);
    expect(done.timings!.limiterWaitMs).toBeLessThanOrEqual(done.timings!.wallMs);
  });

  it("is absent when the sliced path runs without a meter", async () => {
    const { ingest } = fakeIngest();
    const begun = await begin(options(ingest), { ...meta, source, startedAt: 0 });
    if ("finished" in begun) throw new Error("listing failed");
    const progress = await advance(options(ingest), begun.plan, begun.progress);
    const done = await complete(options(ingest), begun.plan, progress, { planStored: false });
    expect(done.timings).toBeUndefined();
  });
});

describe("bounded fields and rejected postings", () => {
  it("reports a bounded field as a schema issue and still applies and completes the run", async () => {
    const { ingest, calls } = fakeIngest();
    const cpu = {
      ...inThreadCpu,
      prepare: async (...args: Parameters<typeof inThreadCpu.prepare>) => ({
        ...(await inThreadCpu.prepare(...args)),
        notes: ["url is 3000 characters (max 2048); stored as null"],
      }),
    };
    const result = await collectSource(source, meta, { ...options(ingest), cpu });
    expect(result).toMatchObject({ listingComplete: true, detailsComplete: true });
    expect(calls.applied).toHaveLength(2);
    expect(calls.finalize[0]!.issues.filter((i) => i.code === "schema")).toHaveLength(2);
  });

  it("a posting the server rejects is an issue and the run is not claimed detail-complete", async () => {
    const { ingest, calls } = fakeIngest({
      applyJobs: async (_runId, jobs) => ({
        applied: jobs.length - 1,
        missingBlobs: [],
        invalid: [{ postingId: "x", reason: "postingId length 600 is outside 1..512" }],
      }),
    });
    const result = await collectSource(source, meta, options(ingest));
    expect(result.detailsComplete).toBe(false);
    expect(calls.finalize[0]!.issues).toContainEqual(
      expect.objectContaining({ code: "schema", postingId: "x" }),
    );
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

describe("conditional listing", () => {
  const ETAG = 'W/"abc"';
  /** Fake Greenhouse that honors If-None-Match and records the requests it served. */
  function board() {
    const served: { url: string; inm: string | null; status: number }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const inm = request.headers.get("if-none-match");
      if (!url.pathname.endsWith("/jobs")) {
        served.push({ url: url.pathname, inm, status: 200 });
        return new Response(fx("greenhouse-detail"));
      }
      const status = inm === ETAG ? 304 : 200;
      served.push({ url: url.pathname, inm, status });
      return status === 304
        ? new Response(null, { status, headers: { etag: ETAG } })
        : new Response(fx("greenhouse-list"), { headers: { etag: ETAG } });
    };
    return { fetchImpl, served };
  }
  const stored = (validator: string | null): Partial<Ingest> => ({
    startRun: async () => ({ validator }),
  });
  // The engine versions the validator with the platform and prepare versions; read it off a real run.
  async function tagged() {
    const { fetchImpl } = board();
    const { ingest, calls } = fakeIngest();
    await collectSource(source, meta, { ...options(ingest), fetch: fetchImpl });
    return calls.finalize[0]!.validator!;
  }

  it("stores the ETag, versioned, after a complete run", async () => {
    expect(await tagged()).toMatch(/^\d+\.\d+\|W\/"abc"$/);
  });

  it("an unchanged board costs one request: no diff, no details, no uploads, run still recorded", async () => {
    const validator = await tagged();
    const { fetchImpl, served } = board();
    const diffs: unknown[] = [];
    const { ingest, calls } = fakeIngest({
      ...stored(validator),
      diff: async (...args) => {
        diffs.push(args);
        return [];
      },
    });
    const result = await collectSource(source, meta, { ...options(ingest), fetch: fetchImpl });
    expect(served).toEqual([{ url: "/v1/boards/stripe/jobs", inm: ETAG, status: 304 }]);
    expect(diffs).toEqual([]);
    expect(calls.applied).toEqual([]);
    expect(calls.raw).toEqual([]);
    expect(result).toMatchObject({
      listingComplete: true,
      detailsComplete: true,
      notModified: true,
      seenIds: [],
      requests: 1,
      changed: 0,
      validator,
    });
    expect(calls.finalize).toHaveLength(1);
  });

  it("a changed board is listed in full and stores the new validator", async () => {
    const old = (await tagged()).replace(ETAG, 'W/"old"');
    const { fetchImpl, served } = board();
    const { ingest, calls } = fakeIngest(stored(old));
    const result = await collectSource(source, meta, { ...options(ingest), fetch: fetchImpl });
    expect(served[0]).toMatchObject({ inm: 'W/"old"', status: 200 });
    expect(result).toMatchObject({ notModified: false, changed: 2 });
    expect(calls.finalize[0]!.seenIds.length).toBeGreaterThan(0);
  });

  it("a validator from other platform or prepare versions is not sent (a map change re-fetches)", async () => {
    const validator = (await tagged()).replace(/^\d+\.\d+/, "0.0");
    const { fetchImpl, served } = board();
    const { ingest } = fakeIngest(stored(validator));
    const result = await collectSource(source, meta, { ...options(ingest), fetch: fetchImpl });
    expect(served[0]).toMatchObject({ inm: null, status: 200 });
    expect(result).toMatchObject({ notModified: false, changed: 2 });
  });

  it("a 304 nobody asked for fails the run and never claims a complete listing", async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 304 });
    const { ingest } = fakeIngest(stored(null));
    const result = await collectSource(source, meta, { ...options(ingest), fetch: fetchImpl });
    expect(result).toMatchObject({ listingComplete: false, notModified: false });
  });

  it("a failed listing sends no validator for the server to keep", async () => {
    const validator = await tagged();
    const fetchImpl: typeof fetch = async () => new Response("boom", { status: 500 });
    const { ingest } = fakeIngest(stored(validator));
    const result = await collectSource(source, meta, { ...options(ingest), fetch: fetchImpl });
    expect(result).toMatchObject({ listingComplete: false, notModified: false });
    expect(result.validator ?? null).toBeNull();
  });
});
