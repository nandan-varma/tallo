import { readFileSync } from "node:fs";
import type { SourceConfig } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { collectSource, type EngineOptions, type Ingest, memoryScratch } from "../src/index.ts";

const fx = (name: string) =>
  readFileSync(new URL(`../../platforms/test/fixtures/${name}.json`, import.meta.url), "utf8");
const source: SourceConfig = {
  id: "greenhouse:stripe",
  platform: "greenhouse",
  key: "stripe",
  company: "Stripe",
  params: {},
};
const ETAG = 'W/"abc"';
const log = { info() {}, warn() {}, error() {} };
const meta = (runId: string) => ({ runId, runnerId: "test", version: "t" });

/** A board; with `conditional` it honors If-None-Match, without it always answers the full listing. */
const board =
  (conditional: boolean): typeof fetch =>
  async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/jobs")) return new Response(fx("greenhouse-detail"));
    if (conditional && request.headers.get("if-none-match") === ETAG)
      return new Response(null, { status: 304, headers: { etag: ETAG } });
    return new Response(fx("greenhouse-list"), { headers: { etag: ETAG } });
  };

/**
 * A small stateful server: it remembers listing hashes, blobs and the validator between runs, and logs every
 * call the engine makes (each one is an HTTP round trip on the runner).
 */
function server(opts: { conditional: boolean }) {
  const calls: string[] = [];
  const hashes = new Map<string, string>();
  const blobs = new Set<string>();
  let validator: string | null = null;
  const note =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    (...a: A): R => {
      calls.push(name);
      return fn(...a);
    };
  const finalize: Ingest["finalize"] = async (_id, body) => {
    validator = body.validator ?? validator;
    return { status: "complete", closureApplied: false, closed: 0, reopened: 0 };
  };
  const diffNow = (postings: { id: string; hash: string }[]) =>
    postings.filter((p) => hashes.get(p.id) !== p.hash).map((p) => p.id);
  const ingest: Ingest = {
    startRun: note("start", async () => ({ validator })),
    diff: note("diff", async (_id, postings) => diffNow(postings)),
    missingBlobs: note("blobs", async (h) => h.filter((x) => !blobs.has(x))),
    putJd: note("putJd", async (hash) => void blobs.add(hash)),
    applyJobs: note("jobs", async (_id, jobs) => {
      const missingBlobs = [...new Set(jobs.map((j) => j.jdHash).filter((h) => !blobs.has(h)))];
      const ready = jobs.filter((j) => blobs.has(j.jdHash));
      for (const j of ready) hashes.set(j.postingId, j.sourceHash);
      return { applied: ready.length, missingBlobs, invalid: [], bounded: [] };
    }),
    putRaw: note("raw", async () => "raw/key"),
    finalize: note("finalize", finalize),
    diffOrFinish: note("diff+finalize", async (id, postings, finish) => {
      const changed = diffNow(postings);
      if (changed.length) return { changed };
      return {
        changed,
        finalized: await finalize(id, {
          ...finish,
          seenIds: postings.map((p) => p.id),
          rawKey: null,
        }),
      };
    }),
  };
  const options: EngineOptions = {
    ingest,
    scratch: memoryScratch(),
    log,
    fetch: board(opts.conditional),
    detailConcurrency: 1,
  };
  const run = async (id: string) => {
    calls.length = 0;
    const outcome = await collectSource(source, meta(id), options);
    return { calls: [...calls], outcome };
  };
  return { run, hashes, blobs };
}

describe("ingest round trips per board", () => {
  it("first run of a new board: no blob check; jobs, one putJd per blob, jobs again", async () => {
    const s = server({ conditional: true });
    const { calls, outcome } = await s.run("run-trips-0001");
    const n = s.blobs.size;
    expect(n).toBeGreaterThan(0);
    expect(calls).toEqual([
      "start",
      "diff+finalize",
      "jobs",
      ...Array(n).fill("putJd"),
      "jobs",
      "raw",
      "finalize",
    ]);
    expect(outcome.changed).toBeGreaterThan(0);
  });

  it("changed postings whose descriptions are stored: start, diff, jobs, raw, finalize", async () => {
    const s = server({ conditional: false });
    await s.run("run-trips-0001");
    s.hashes.clear(); // every fingerprint differs, every description is already stored
    const { calls } = await s.run("run-trips-0002");
    expect(calls).toEqual(["start", "diff+finalize", "jobs", "raw", "finalize"]);
  });

  it("an unchanged listing (no 304): start, diff+finalize", async () => {
    const combined = server({ conditional: false });
    await combined.run("run-trips-0001");
    const after = await combined.run("run-trips-0002");
    expect(after.calls).toEqual(["start", "diff+finalize"]);
    expect(after.outcome).toMatchObject({
      listingComplete: true,
      detailsComplete: true,
      notModified: false,
      changed: 0,
      rawKey: null,
    });
    expect(after.outcome.seenIds.length).toBeGreaterThan(0);
  });

  it("a 304 board: start, finalize", async () => {
    const s = server({ conditional: true });
    await s.run("run-trips-0001");
    const { calls, outcome } = await s.run("run-trips-0002");
    expect(calls).toEqual(["start", "finalize"]);
    expect(outcome).toMatchObject({ notModified: true, listingComplete: true });
  });
});
