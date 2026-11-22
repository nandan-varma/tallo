import { gzip, prepareJob, sha256 } from "@tallo/catalog";
import { memoryBlobs, schema } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
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
  it.each([
    [
      new Error(
        "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.",
      ),
      503,
    ],
    [new Error("Failed query", { cause: new Error("D1_ERROR: D1 DB is overloaded") }), 503],
    [new Error("Failed query", { cause: new Error("no such column") }), 500],
    [new Error("D1_ERROR: Too many resources consumed within a 10 second window."), 503],
    [new Error("upstream overloaded"), 500],
  ])("signals retry only for D1 overload: %s", async (error, status) => {
    const { call, db } = setup();
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const select = vi.spyOn(db, "select").mockImplementation(() => {
      throw error;
    });
    try {
      const response = await call("/v1/sources", INGEST);
      expect(response.status).toBe(status);
      expect(response.headers.get("retry-after")).toBe(status === 503 ? "10" : null);
      expect(await response.json()).toEqual({
        error: status === 503 ? "Database busy; retry later" : "Internal error",
      });
    } finally {
      select.mockRestore();
      report.mockRestore();
    }
  });

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

  it("diff-or-finish: finalizes in the same call when nothing changed, and needs the token", async () => {
    const { call } = setup();
    const runId = "run-00000009";
    await call("/v1/runs", INGEST, {
      method: "POST",
      json: { runId, source, runnerId: "mac", collectorVersion: "t", startedAt: now() },
    });
    const finish = {
      listingComplete: true,
      detailsComplete: true,
      emptyIsAuthoritative: true,
      requests: 1,
      finishedAt: now(),
      issues: [],
    };
    const route = `/v1/runs/${runId}/diff-or-finish`;
    expect(
      (await call(route, null, { method: "POST", json: { postings: [], finish } })).status,
    ).toBe(401);
    const body = await (
      await call(route, INGEST, { method: "POST", json: { postings: [], finish } })
    ).json();
    expect(body).toMatchObject({ changed: [], finalized: { status: "complete" } });
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
    expect(early).toEqual({
      applied: 0,
      invalid: [],
      bounded: [],
      missingBlobs: [job.facts.jdHash],
    });

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
    ).toEqual({ applied: 1, invalid: [], bounded: [], missingBlobs: [] });
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
    const companies = await (await call("/v1/companies?prefix=ac", null)).json();
    expect(companies).toMatchObject({ count: 1, companies: [{ name: "Acme", slug: "acme" }] });
    const titles = await (await call("/v1/titles?prefix=soft", null)).json();
    expect(titles).toMatchObject({ count: 1, titles: ["software"], truncated: false });
    const missing = await call("/v1/jobs/999", null);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "unknown" } });
  });

  it("serves the slim status view of sources and filters run history", async () => {
    const { call } = setup();
    const started = now();
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
        json: {
          runId,
          source: src,
          runnerId: "mac",
          collectorVersion: "t",
          startedAt: started - n,
        },
      });
      await call(`/v1/runs/${runId}/finalize`, INGEST, {
        method: "POST",
        json: {
          seenIds: [],
          listingComplete: finish.listingComplete,
          detailsComplete: true,
          emptyIsAuthoritative: true,
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

  it("resumes the admin regroup from the opaque cursor it returned", async () => {
    const { call, db } = setup();
    const at = now();
    await db.insert(schema.jobs).values(
      [1, 2, 3].map((i) => ({
        sourceId: source.id,
        postingId: `cursor-${i}`,
        company: "Acme",
        companySlug: "acme",
        title: `Engineer ${i}`,
        excerpt: "",
        jdHash: "a".repeat(64),
        jdBytes: 1,
        sourceHash: "b".repeat(64),
        facts: {},
        sortAt: at,
        firstSeenAt: at,
        updatedAt: at,
        dedupeKey: `key-${i}`,
      })),
    );

    const first = (await (
      await call("/v1/admin/dedupe?limit=1", INGEST, { method: "POST" })
    ).json()) as { next: string | null };
    expect(first.next).not.toBeNull();
    // The old route cap was 64 characters; the opaque cursor is longer.
    expect(first.next!.length).toBeGreaterThan(64);
    expect(
      (
        await call(`/v1/admin/dedupe?limit=1&after=${encodeURIComponent(first.next!)}`, INGEST, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
  });
});

describe("ingest body limits", () => {
  const MB = 1024 * 1024;

  async function startRun(call: ReturnType<typeof setup>["call"], runId: string) {
    const res = await call("/v1/runs", INGEST, {
      method: "POST",
      json: { runId, source, runnerId: "mac", collectorVersion: "t", startedAt: now() },
    });
    expect(res.status).toBe(201);
  }

  it("refuses a JD upload whose declared length is over the cap, before reading it", async () => {
    const { call } = setup();
    const res = await call(`/v1/blobs/jd/${"a".repeat(64)}`, INGEST, {
      method: "PUT",
      headers: { "content-length": String(26 * MB) },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(413);
  });

  it("refuses a JD upload that streams past the cap without declaring a length", async () => {
    const { call } = setup();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(26 * MB));
        controller.close();
      },
    });
    const res = await call(`/v1/blobs/jd/${"a".repeat(64)}`, INGEST, {
      method: "PUT",
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("refuses a gzip bomb: a small JD upload that inflates past the cap", async () => {
    const { call } = setup();
    // 26 MB of zeros is a few tens of kilobytes gzipped: small on the wire, over the cap once inflated.
    const bomb = await gzip(new Uint8Array(26 * MB));
    expect(bomb.byteLength).toBeLessThan(1 * MB);
    const res = await call(`/v1/blobs/jd/${"a".repeat(64)}`, INGEST, {
      method: "PUT",
      body: bomb,
    });
    expect(res.status).toBe(413);
  });

  it("refuses a raw pack for a run that is no longer running, and stores nothing", async () => {
    const { call, db } = setup();
    const runId = "run-raw-finished";
    await startRun(call, runId);
    await db.update(schema.runs).set({ status: "partial" }).where(eq(schema.runs.id, runId));
    const raw = await gzip(new TextEncoder().encode('{"id":"7"}\n'));
    const res = await call(`/v1/runs/${runId}/raw`, INGEST, { method: "PUT", body: raw });
    expect(res.status).toBe(409);
    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(row?.rawKey).toBeNull();
  });

  it("answers a retried raw pack for a finished run with the key it already stored", async () => {
    const { call, db } = setup();
    const runId = "run-raw-retry";
    await startRun(call, runId);
    const raw = await gzip(new TextEncoder().encode('{"id":"7"}\n'));
    const first = await call(`/v1/runs/${runId}/raw`, INGEST, { method: "PUT", body: raw });
    const key = `raw/${source.id}/${runId}.ndjson.gz`;
    expect(await first.json()).toEqual({ key });
    // The run finishes, then the runner retries the upload because its first response was lost.
    await db.update(schema.runs).set({ status: "complete" }).where(eq(schema.runs.id, runId));
    const retry = await call(`/v1/runs/${runId}/raw`, INGEST, { method: "PUT", body: raw });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ key });
  });

  it("refuses a raw pack whose declared length is over the cap, for a running run", async () => {
    const { call, db } = setup();
    const runId = "run-raw-big";
    await startRun(call, runId);
    const res = await call(`/v1/runs/${runId}/raw`, INGEST, {
      method: "PUT",
      headers: { "content-length": String(26 * MB) },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(413);
    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(row).toMatchObject({ rawKey: null });
  });
});
