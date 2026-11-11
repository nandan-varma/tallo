import { gzip, prepareJob, sha256 } from "@tallo/catalog";
import { memoryBlobs } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";

const source = {
  id: "greenhouse:acme",
  platform: "greenhouse",
  key: "acme",
  company: "Acme",
  params: {},
};
const INGEST = "ingest-token";

function setup() {
  const db = testDb();
  const blobs = memoryBlobs();
  const app = createApp({ db, blobs, ingestToken: INGEST });
  const call = (path: string, token: string | null, init: RequestInit & { json?: unknown } = {}) =>
    app.request(path, {
      ...init,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.json ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.json ? { body: JSON.stringify(init.json) } : {}),
    });
  return { call, db };
}

const now = () => Math.floor(Date.now() / 1000);

describe("api", () => {
  it("serves the public reads without a token and needs the ingest token for everything else", async () => {
    const { call } = setup();
    expect((await call("/health", null)).status).toBe(200);
    expect((await call("/v1/search?title=software+engineer", null)).status).toBe(200);
    expect((await call("/v1/sources/status", null)).status).toBe(401);
    expect((await call("/v1/sources/status", "wrong")).status).toBe(401);
    expect((await call("/v1/sources", "read-token")).status).toBe(401);
    expect((await call("/v1/runs", null, { method: "POST", json: {} })).status).toBe(401);
  });

  it("no longer serves the free-text feed or the POST search", async () => {
    const { call } = setup();
    expect((await call("/v1/jobs?q=software", null)).status).toBe(404);
    expect((await call("/v1/jobs", null)).status).toBe(404);
    expect(
      (await call("/v1/jobs/search", null, { method: "POST", json: { queries: ["software"] } }))
        .status,
    ).toBe(404);
  });

  it("runs a full ingest round trip and serves the job with its description", async () => {
    const { call } = setup();
    const runId = "run-00000001";
    expect(
      (
        await call("/v1/runs", INGEST, {
          method: "POST",
          json: { runId, source, runnerId: "mac", collectorVersion: "t", startedAt: now() },
        })
      ).status,
    ).toBe(201);

    const job = await prepareJob(
      {
        postingId: "7",
        title: "Software Engineer",
        description: "Build the future.",
        locations: [{ text: "Austin, TX", countryCode: "US", primary: true }],
        compensation: [],
        experience: [],
        extras: {},
      },
      source,
      "a".repeat(64),
    );
    const diffed = await (
      await call(`/v1/runs/${runId}/diff`, INGEST, {
        method: "POST",
        json: { postings: [{ id: "7", hash: "a".repeat(64) }] },
      })
    ).json();
    expect(diffed).toEqual({ changed: ["7"] });

    // Applying before uploading the blob reports it as missing.
    const early = await (
      await call(`/v1/runs/${runId}/jobs`, INGEST, { method: "POST", json: { jobs: [job.facts] } })
    ).json();
    expect(early).toEqual({ applied: 0, missingBlobs: [job.facts.jdHash] });

    const wrong = await call(`/v1/blobs/jd/${"b".repeat(64)}`, INGEST, {
      method: "PUT",
      body: job.jd,
    });
    expect(wrong.status).toBe(400);
    expect(
      (await call(`/v1/blobs/jd/${job.facts.jdHash}`, INGEST, { method: "PUT", body: job.jd }))
        .status,
    ).toBe(204);
    expect(
      await (
        await call("/v1/blobs/check", INGEST, {
          method: "POST",
          json: { hashes: [job.facts.jdHash, "c".repeat(64)] },
        })
      ).json(),
    ).toEqual({ missing: ["c".repeat(64)] });

    expect(
      await (
        await call(`/v1/runs/${runId}/jobs`, INGEST, {
          method: "POST",
          json: { jobs: [job.facts] },
        })
      ).json(),
    ).toEqual({ applied: 1, missingBlobs: [] });
    const raw = await gzip(new TextEncoder().encode('{"id":"7"}\n'));
    expect(
      await (await call(`/v1/runs/${runId}/raw`, INGEST, { method: "PUT", body: raw })).json(),
    ).toEqual({ key: `raw/${source.id}/${runId}.ndjson.gz` });
    const done = await (
      await call(`/v1/runs/${runId}/finalize`, INGEST, {
        method: "POST",
        json: {
          seenIds: ["7"],
          listingComplete: true,
          detailsComplete: true,
          emptyIsAuthoritative: false,
          requests: 2,
          finishedAt: 2,
          rawKey: null,
          issues: [],
        },
      })
    ).json();
    expect(done).toMatchObject({ status: "complete", closureApplied: true });

    const search = (await (await call("/v1/search?title=software+engineer", null)).json()) as {
      results: { id: string }[];
    };
    expect(search.results).toHaveLength(1);
    const detail = await (await call(`/v1/jobs/${search.results[0]?.id}`, null)).json();
    expect(detail).toMatchObject({
      title: "Software Engineer",
      company: "Acme",
      description: "Build the future.",
      descriptionChars: 17,
      descriptionNext: null,
    });
    expect(detail).not.toHaveProperty("jdHash");
    expect(detail).not.toHaveProperty("facts");
    const missing = await call("/v1/jobs/999", null);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("serves the slim status view of sources and filters run history", async () => {
    const { call } = setup();
    const board = (id: string) => ({ ...source, id, key: id.split(":")[1], company: id });
    /** Starts and finalizes one run; `listingComplete` decides complete vs partial. */
    const run = async (
      n: number,
      src: ReturnType<typeof board>,
      finish: { listingComplete: boolean; issues?: { code: string; message: string }[] },
    ) => {
      const runId = `run-0000000${n}`;
      await call("/v1/runs", INGEST, {
        method: "POST",
        json: { runId, source: src, runnerId: "mac", collectorVersion: "t", startedAt: now() - n },
      });
      await call(`/v1/runs/${runId}/finalize`, INGEST, {
        method: "POST",
        json: {
          seenIds: [],
          listingComplete: finish.listingComplete,
          detailsComplete: true,
          emptyIsAuthoritative: false,
          requests: 1,
          finishedAt: now(),
          rawKey: null,
          issues: finish.issues ?? [],
        },
      });
    };
    await run(1, board("greenhouse:acme"), { listingComplete: true });
    await run(2, board("greenhouse:beta"), { listingComplete: false });
    await run(3, board("greenhouse:gamma"), {
      listingComplete: true,
      issues: [{ code: "detail", message: "one posting failed" }],
    });

    expect((await call("/v1/sources/status", null)).status).toBe(401);
    const status = (await (await call("/v1/sources/status", INGEST)).json()) as Record<
      string,
      unknown
    >[];
    expect(status.map((s) => s.id)).toEqual([
      "greenhouse:acme",
      "greenhouse:beta",
      "greenhouse:gamma",
    ]);
    for (const row of status) {
      expect(row).toHaveProperty("freshness");
      expect(row).toHaveProperty("lastStatus");
      expect(row).not.toHaveProperty("params");
      expect(row).not.toHaveProperty("consecutiveFailures");
    }
    // The full record is unchanged: the runner's `sources --dead` reads status and failures.
    const full = (await (await call("/v1/sources", INGEST)).json()) as Record<string, unknown>[];
    expect(full[0]).toMatchObject({ id: "greenhouse:acme", status: "active", params: {} });
    expect(full[0]).toHaveProperty("consecutiveFailures");

    const runs = (await (await call("/v1/runs", INGEST)).json()) as { status: string }[];
    // Newest first: run 1 started last.
    expect(runs.map((r) => r.status)).toEqual(["complete", "partial", "complete"]);
    const attention = (await (await call("/v1/runs?attention=true", INGEST)).json()) as {
      sourceId: string;
    }[];
    expect(attention.map((r) => r.sourceId).sort()).toEqual([
      "greenhouse:beta",
      "greenhouse:gamma",
    ]);
    const limited = (await (await call("/v1/runs?limit=1", INGEST)).json()) as unknown[];
    expect(limited).toHaveLength(1);
    const reads = await call("/v1/runs", INGEST);
    expect(reads.headers.get("cache-control")).toBe("private, max-age=30");
    expect((await call("/v1/runs?limit=0", INGEST)).status).toBe(400);
    expect((await call("/v1/runs?limit=201", INGEST)).status).toBe(400);
    expect((await call("/v1/runs?attention=maybe", INGEST)).status).toBe(400);
  });

  it("rejects malformed input and maps ingest conflicts to 409", async () => {
    const { call } = setup();
    expect((await call("/v1/runs", INGEST, { method: "POST", json: { runId: "x" } })).status).toBe(
      400,
    );
    const body = { source, runnerId: "mac", collectorVersion: "t", startedAt: now() };
    await call("/v1/runs", INGEST, { method: "POST", json: { ...body, runId: "run-00000001" } });
    expect(
      (await call("/v1/runs", INGEST, { method: "POST", json: { ...body, runId: "run-00000002" } }))
        .status,
    ).toBe(409);
    expect(
      (await call("/v1/runs/missing/diff", INGEST, { method: "POST", json: { postings: [] } }))
        .status,
    ).toBe(404);
    expect(await sha256("x")).toHaveLength(64);
  });

  it("collapses one posting listed in two locations and serves every location", async () => {
    const { call } = setup();
    const runId = "run-dedupe-01";
    expect(
      (
        await call("/v1/runs", INGEST, {
          method: "POST",
          json: { runId, source, runnerId: "mac", collectorVersion: "t", startedAt: now() },
        })
      ).status,
    ).toBe(201);
    const listing = (postingId: string, city: string, applyUrl: string) =>
      prepareJob(
        {
          postingId,
          title: "Software Engineer",
          description: "Same text in both places.",
          locations: [{ text: city, countryCode: "US", primary: true }],
          compensation: [],
          experience: [],
          extras: {},
          applyUrl,
        },
        source,
        "a".repeat(64),
      );
    const [austin, denver] = await Promise.all([
      listing("1", "Austin, TX", "https://x/1"),
      listing("2", "Denver, CO", "https://x/2"),
    ]);
    await call(`/v1/blobs/jd/${austin.facts.jdHash}`, INGEST, { method: "PUT", body: austin.jd });
    await call(`/v1/runs/${runId}/jobs`, INGEST, {
      method: "POST",
      json: { jobs: [austin.facts, denver.facts] },
    });

    // Ingest stores the key the runner computed; the rebuild groups the two rows.
    expect(austin.facts.dedupeKey).toBe(denver.facts.dedupeKey);
    expect((await call("/v1/admin/dedupe", null, { method: "POST" })).status).toBe(401);
    expect(await (await call("/v1/admin/dedupe", INGEST, { method: "POST" })).json()).toEqual({
      keys: 1,
      changed: 1,
      next: null,
    });

    type Variant = { id: string; applyUrl: string };
    const search = (await (await call("/v1/search?title=software+engineer", null)).json()) as {
      results: { id: string; locations: number }[];
    };
    // The duplicate listing is grouped under the canonical one, so the results list shows one hit.
    expect(search.results).toHaveLength(1);
    const hit = search.results[0];
    const page = (await (await call(`/v1/jobs/${hit?.id}`, null)).json()) as {
      variants: Variant[];
    };
    expect(page.variants.map((v) => v.applyUrl)).toEqual(["https://x/1", "https://x/2"]);
    // The other listing's page shows the same group.
    const sibling = page.variants[1]?.id;
    const second = (await (await call(`/v1/jobs/${sibling}`, null)).json()) as {
      variants: Variant[];
    };
    expect(second.variants).toHaveLength(2);
    expect(
      await (await call("/v1/admin/dedupe/backfill?after=0", INGEST, { method: "POST" })).json(),
    ).toEqual({ updated: 0, more: false, next: 0 });
  });
});
