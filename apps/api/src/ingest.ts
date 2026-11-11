import { zValidator } from "@hono/zod-validator";
import { dedupeKey, gunzip, sha256 } from "@tallo/catalog";
import {
  blobCheckSchema,
  createRunSchema,
  diffSchema,
  finalizeSchema,
  jobsBatchSchema,
} from "@tallo/contracts";
import {
  applyJobs,
  type BlobStore,
  backfillDedupeKeys,
  type Db,
  diff,
  finalize,
  jdKey,
  listRuns,
  listSourceStatus,
  listSources,
  rebuildDuplicates,
  runsSearchSchema,
  schema,
  startRun,
  storeRawPack,
} from "@tallo/db";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";

const MAX_BLOB_BYTES = 25 * 1024 * 1024;
const hash = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Sources and runs (read by the runner and the operator), plus the runner's ingest writes. Every route needs the
 * ingest token: none of this is public.
 */
export function ingestRoutes({
  db,
  blobs,
  write,
}: {
  db: Db;
  blobs: BlobStore;
  write: MiddlewareHandler;
}) {
  const routes = new Hono();

  routes.get("/v1/sources", write, async (c) => c.json(await listSources(db)));

  /** Slim per-source view for the status page; `/v1/sources` stays the full record for the runner. */
  routes.get("/v1/sources/status", write, async (c) => c.json(await listSourceStatus(db)));

  routes.get("/v1/runs", write, zValidator("query", runsSearchSchema), async (c) => {
    c.header("cache-control", "private, max-age=30");
    return c.json(await listRuns(db, c.req.valid("query")));
  });

  routes.post("/v1/runs", write, zValidator("json", createRunSchema), async (c) => {
    await startRun(db, c.req.valid("json"));
    return c.json({ runId: c.req.valid("json").runId }, 201);
  });

  routes.post("/v1/runs/:id/diff", write, zValidator("json", diffSchema), async (c) =>
    c.json({ changed: await diff(db, c.req.param("id"), c.req.valid("json").postings) }),
  );

  routes.post("/v1/blobs/check", write, zValidator("json", blobCheckSchema), async (c) => {
    const missing = (
      await Promise.all(
        c.req.valid("json").hashes.map(async (h) => ((await blobs.has(jdKey(h))) ? null : h)),
      )
    ).filter(Boolean);
    return c.json({ missing });
  });

  /** Description blobs are addressed by the sha256 of their text; the address is verified. */
  routes.put("/v1/blobs/jd/:hash", write, zValidator("param", z.object({ hash })), async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_BLOB_BYTES) return c.json({ error: "Too large" }, 413);
    const text = await gunzip(bytes).catch(() => null);
    if (!text || (await sha256(text)) !== c.req.valid("param").hash)
      return c.json({ error: "Hash mismatch" }, 400);
    await blobs.put(jdKey(c.req.valid("param").hash), bytes);
    return c.body(null, 204);
  });

  routes.post("/v1/runs/:id/jobs", write, zValidator("json", jobsBatchSchema), async (c) => {
    return c.json(await applyJobs(db, blobs, c.req.param("id"), c.req.valid("json").jobs));
  });

  /** Raw source payloads for the run (changed postings), kept for replay and debugging. */
  routes.put("/v1/runs/:id/raw", write, async (c) => {
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

  routes.post("/v1/runs/:id/finalize", write, zValidator("json", finalizeSchema), async (c) =>
    c.json(await finalize(db, c.req.param("id"), c.req.valid("json"))),
  );

  /** Fills dedupe keys for rows stored before the key existed. Call with `after=<next>` until `more` is false. */
  routes.post(
    "/v1/admin/dedupe/backfill",
    write,
    zValidator("query", z.object({ after: z.coerce.number().int().min(0).optional() })),
    async (c) =>
      c.json(
        await backfillDedupeKeys(db, (row) => dedupeKey(row), {
          after: c.req.valid("query").after ?? 0,
        }),
      ),
  );

  /**
   * Regroups duplicates now (`full` walks every key; the cron does the incremental pass). Call with
   * `after=<next>` until `next` is null.
   */
  routes.post(
    "/v1/admin/dedupe",
    write,
    zValidator(
      "query",
      z.object({
        full: z
          .enum(["true", "false"])
          .transform((v) => v === "true")
          .optional(),
        after: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(5000).optional(),
      }),
    ),
    async (c) => {
      const { full, after, limit } = c.req.valid("query");
      return c.json(await rebuildDuplicates(db, undefined, { full, after, limit }));
    },
  );

  return routes;
}
