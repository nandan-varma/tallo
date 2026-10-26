import { gzip, prepareJob, sha256 } from "@tallo/catalog";
import { memoryBlobs, schema } from "@tallo/db";
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
const READ = "read-token";
const INGEST = "ingest-token";

function setup() {
  const db = testDb();
  const blobs = memoryBlobs();
  const app = createApp({ db, blobs, readToken: READ, ingestToken: INGEST });
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
  it("requires the right token for each scope", async () => {
    const { call } = setup();
    expect((await call("/health", null)).status).toBe(200);
    expect((await call("/v1/jobs", null)).status).toBe(401);
    expect((await call("/v1/jobs", "wrong")).status).toBe(401);
    expect((await call("/v1/jobs", READ)).status).toBe(200);
    expect((await call("/v1/runs", READ, { method: "POST", json: {} })).status).toBe(401);
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

    const search = (await (await call("/v1/jobs?q=software", READ)).json()) as {
      jobs: { id: number }[];
    };
    expect(search.jobs).toHaveLength(1);
    const detail = await (await call(`/v1/jobs/${search.jobs[0]?.id}`, READ)).json();
    expect(detail).toMatchObject({
      title: "Software Engineer",
      company: "Acme",
      description: "Build the future.",
      countryCode: "US",
    });
    expect(detail).not.toHaveProperty("jdHash");
    expect((await call("/v1/jobs/999", READ)).status).toBe(404);
  });

  it("serves precomputed facets behind the read token and rebuilds them on admin request", async () => {
    const { call, db } = setup();
    expect((await call("/v1/facets", null)).status).toBe(401);
    expect((await call("/v1/admin/facets/rebuild", READ, { method: "POST" })).status).toBe(401);
    expect(await (await call("/v1/facets", READ)).json()).toMatchObject({
      computedAt: null,
      department: [],
    });

    await db
      .insert(schema.sources)
      .values({ ...source, companySlug: "acme", lastListedAt: now(), params: {} });
    await db.insert(schema.jobs).values({
      sourceId: source.id,
      postingId: "7",
      company: "Acme",
      companySlug: "acme",
      title: "Software Engineer",
      classifierVersion: 1,
      excerpt: "x",
      jdHash: "a".repeat(64),
      jdBytes: 1,
      sourceHash: "b".repeat(64),
      facts: {},
      sortAt: 1,
      firstSeenAt: 1,
      updatedAt: 1,
      department: "Engineering",
      employmentType: "full_time",
      workMode: "remote",
      countryCode: "US",
    });

    expect(
      await (await call("/v1/admin/facets/rebuild", INGEST, { method: "POST" })).json(),
    ).toEqual({ values: 4 });
    const facets = await call("/v1/facets", READ);
    expect(facets.headers.get("cache-control")).toBe("private, max-age=300");
    expect(await facets.json()).toMatchObject({
      department: [{ value: "Engineering", count: 1 }],
      employmentType: [{ value: "full_time", count: 1 }],
      workMode: [{ value: "remote", count: 1 }],
      country: [{ value: "US", count: 1 }],
    });
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
});
