import { zValidator } from "@hono/zod-validator";
import { CLASSIFIER_VERSION, classify, gunzip, sha256 } from "@tallo/catalog";
import {
  blobCheckSchema,
  createRunSchema,
  diffSchema,
  finalizeSchema,
  type JobLocation,
  jobsBatchSchema,
} from "@tallo/contracts";
import type { BlobStore, Db } from "@tallo/db";
import {
  applyJobs,
  diff,
  finalize,
  getJob,
  IngestError,
  jdKey,
  listFacets,
  listRuns,
  listSourceStatus,
  listSources,
  rebuildFacets,
  reclassify,
  runsSearchSchema,
  schema,
  searchJobs,
  searchSchema,
  startRun,
  storeRawPack,
} from "@tallo/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

export interface Deps {
  db: Db;
  blobs: BlobStore;
  readToken: string;
  ingestToken: string;
}

const MAX_BLOB_BYTES = 25 * 1024 * 1024;
const hash = z.string().regex(/^[0-9a-f]{64}$/);

/** Internal API. Reads need READ_TOKEN; writes need INGEST_TOKEN (which may also read). */
export function createApp({ db, blobs, readToken, ingestToken }: Deps) {
  const app = new Hono();
  const read = bearerAuth({ verifyToken: (t) => t === readToken || t === ingestToken });
  const write = bearerAuth({ token: ingestToken });

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof IngestError) return c.json({ error: error.message }, error.status);
    console.error(error);
    return c.json({ error: "Internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ---- reads ----------------------------------------------------------------------------
  app.get("/v1/jobs", read, zValidator("query", searchSchema), async (c) => {
    c.header("cache-control", "private, max-age=30");
    return c.json(await searchJobs(db, c.req.valid("query")));
  });

  app.get(
    "/v1/jobs/:id",
    read,
    zValidator("param", z.object({ id: z.coerce.number().int().positive() })),
    async (c) => {
      const job = await getJob(db, c.req.valid("param").id);
      if (!job) return c.json({ error: "Not found" }, 404);
      const blob = await blobs.get(jdKey(job.jdHash));
      const { jdHash: _hash, sourceHash: _source, ...rest } = job;
      c.header("cache-control", "private, max-age=300");
      return c.json({
        ...rest,
        description: blob ? new TextDecoder().decode(await gunzip(blob)) : null,
      });
    },
  );

  app.get("/v1/sources", read, async (c) => c.json(await listSources(db)));

  /** Slim per-source view for the status page; `/v1/sources` stays the full record for the runner. */
  app.get("/v1/sources/status", read, async (c) => c.json(await listSourceStatus(db)));

  /** Precomputed counts for the filter dropdowns; a few rows read per request. */
  app.get("/v1/facets", read, async (c) => {
    c.header("cache-control", "private, max-age=300");
    return c.json(await listFacets(db));
  });

  app.get("/v1/runs", read, zValidator("query", runsSearchSchema), async (c) => {
    c.header("cache-control", "private, max-age=30");
    return c.json(await listRuns(db, c.req.valid("query")));
  });

  // ---- ingest (runner) ------------------------------------------------------------------
  app.post("/v1/runs", write, zValidator("json", createRunSchema), async (c) => {
    await startRun(db, c.req.valid("json"));
    return c.json({ runId: c.req.valid("json").runId }, 201);
  });

  app.post("/v1/runs/:id/diff", write, zValidator("json", diffSchema), async (c) =>
    c.json({ changed: await diff(db, c.req.param("id"), c.req.valid("json").postings) }),
  );

  app.post("/v1/blobs/check", write, zValidator("json", blobCheckSchema), async (c) => {
    const missing = (
      await Promise.all(
        c.req.valid("json").hashes.map(async (h) => ((await blobs.has(jdKey(h))) ? null : h)),
      )
    ).filter(Boolean);
    return c.json({ missing });
  });

  /** Description blobs are addressed by the sha256 of their text; the address is verified. */
  app.put("/v1/blobs/jd/:hash", write, zValidator("param", z.object({ hash })), async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_BLOB_BYTES) return c.json({ error: "Too large" }, 413);
    const text = await gunzip(bytes).catch(() => null);
    if (!text || (await sha256(text)) !== c.req.valid("param").hash)
      return c.json({ error: "Hash mismatch" }, 400);
    await blobs.put(jdKey(c.req.valid("param").hash), bytes);
    return c.body(null, 204);
  });

  app.post("/v1/runs/:id/jobs", write, zValidator("json", jobsBatchSchema), async (c) => {
    return c.json(await applyJobs(db, blobs, c.req.param("id"), c.req.valid("json").jobs));
  });

  /** Raw source payloads for the run (changed postings), kept for replay and debugging. */
  app.put("/v1/runs/:id/raw", write, async (c) => {
    const run = (
      await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, c.req.param("id")))
        .limit(1)
    )[0];
    if (!run) return c.json({ error: "Unknown run" }, 404);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_BLOB_BYTES) return c.json({ error: "Too large" }, 413);
    const key = await storeRawPack(db, blobs, run.id, bytes);
    return c.json({ key });
  });

  app.post("/v1/runs/:id/finalize", write, zValidator("json", finalizeSchema), async (c) =>
    c.json(await finalize(db, c.req.param("id"), c.req.valid("json"))),
  );

  /** Recount facets now instead of waiting for the hourly cron (e.g. right after a deploy). */
  app.post("/v1/admin/facets/rebuild", write, async (c) => c.json(await rebuildFacets(db)));

  /** Upgrade heuristic flags after a rule change, from stored facts. Call until `more` is false. */
  app.post("/v1/admin/reclassify", write, async (c) =>
    c.json(
      await reclassify(
        db,
        (row) =>
          classify({
            title: row.title,
            department: row.department ?? undefined,
            team: row.team ?? undefined,
            locations: Array.isArray(row.locations) ? (row.locations as JobLocation[]) : [],
          }),
        CLASSIFIER_VERSION,
      ),
    ),
  );

  return app;
}
