import { zValidator } from "@hono/zod-validator";
import { GunzipLimitError, gunzip, sha256 } from "@tallo/catalog";
import {
  blobCheckSchema,
  createRunSchema,
  diffOrFinishSchema,
  diffSchema,
  finalizeSchema,
  jobsBatchSchema,
} from "@tallo/contracts";
import {
  applyJobs,
  type BlobStore,
  type Db,
  diff,
  diffOrFinish,
  finalize,
  jdKey,
  listRuns,
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
 * The request body as bytes, or null when it is over `max`. A declared length is refused before anything is read;
 * an undeclared one is counted as it streams in, and the stream is cancelled at the first byte past the limit.
 */
async function bodyBytes(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer());
}

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

  routes.get("/v1/runs", write, zValidator("query", runsSearchSchema), async (c) => {
    c.header("cache-control", "private, max-age=30");
    return c.json(await listRuns(db, c.req.valid("query")));
  });

  routes.post("/v1/runs", write, zValidator("json", createRunSchema), async (c) => {
    const { validator } = await startRun(db, c.req.valid("json"));
    return c.json({ runId: c.req.valid("json").runId, validator }, 201);
  });

  routes.post("/v1/runs/:id/diff", write, zValidator("json", diffSchema), async (c) =>
    c.json({ changed: await diff(db, c.req.param("id"), c.req.valid("json").postings) }),
  );

  /** `diff`, plus the finalize when nothing changed: one call for an unchanged board. */
  routes.post(
    "/v1/runs/:id/diff-or-finish",
    write,
    zValidator("json", diffOrFinishSchema),
    async (c) => {
      const { postings, finish } = c.req.valid("json");
      return c.json(await diffOrFinish(db, c.req.param("id"), postings, finish));
    },
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
    const bytes = await bodyBytes(c.req.raw, MAX_BLOB_BYTES);
    if (!bytes) return c.json({ error: "Too large" }, 413);
    // The text is inflated only up to the same cap: a small gzip can inflate to far more.
    let text: Uint8Array | null;
    try {
      text = await gunzip(bytes, MAX_BLOB_BYTES);
    } catch (error) {
      if (error instanceof GunzipLimitError) return c.json({ error: "Too large" }, 413);
      text = null;
    }
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
    // A raw pack belongs to a run that is still collecting. A finished run's pack would never be pruned as its own.
    if (run.status !== "running") {
      // A retry after the run finished (the response to the first upload was lost) gets the pack it already stored.
      if (run.rawKey !== null && run.rawUploaded === 1) return c.json({ key: run.rawKey });
      return c.json({ error: "Run is not running" }, 409);
    }
    const bytes = await bodyBytes(c.req.raw, MAX_BLOB_BYTES);
    if (!bytes) return c.json({ error: "Too large" }, 413);
    const key = await storeRawPack(db, blobs, run.id, bytes);
    return c.json({ key });
  });

  routes.post("/v1/runs/:id/finalize", write, zValidator("json", finalizeSchema), async (c) =>
    c.json(await finalize(db, c.req.param("id"), c.req.valid("json"))),
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
        after: z.string().max(8192).optional(),
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
