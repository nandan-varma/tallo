import { zValidator } from "@hono/zod-validator";
import { CLASSIFIER_VERSION, classify, dedupeKey, gunzip, sha256 } from "@tallo/catalog";
import {
  blobCheckSchema,
  createRunSchema,
  diffSchema,
  editResumeSchema,
  finalizeSchema,
  importResumeSchema,
  type JobLocation,
  jobsBatchSchema,
  resumeDocSchema,
  saveProfileSchema,
  searchPageSchema,
  tailorResumeSchema,
} from "@tallo/contracts";
import type { BlobStore, Db } from "@tallo/db";
import {
  applyJobs,
  backfillDedupeKeys,
  deleteResume,
  diff,
  finalize,
  getJob,
  getProfile,
  getResume,
  IngestError,
  jdKey,
  listResumes,
  listRuns,
  listSourceStatus,
  listSources,
  listVariants,
  rebuildDuplicates,
  reclassify,
  runsSearchSchema,
  saveProfile,
  saveResume,
  schema,
  searchJobs,
  searchSchema,
  startRun,
  storeRawPack,
} from "@tallo/db";
import { resumeToText } from "@tallo/resume";
import {
  editResume,
  fitCheck,
  importResume,
  tailorResume,
  writeCoverLetter,
} from "@tallo/resume/ai";
import { createJobAgent } from "@tallo/search-ai";
import { createAgentUIStreamResponse, type LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { CHAT_MAX_BODY_BYTES, RESUME_MAX_BODY_BYTES } from "./ai.ts";
import { applicationRoutes } from "./applications.ts";
import { jobsPort, searchPage } from "./jobs-port.ts";

export interface Deps {
  db: Db;
  blobs: BlobStore;
  readToken: string;
  ingestToken: string;
  /** The assistant's model; null or absent when AI is not configured. Called per request. */
  model?: () => LanguageModel | null;
}

const MAX_BLOB_BYTES = 25 * 1024 * 1024;
const hash = z.string().regex(/^[0-9a-f]{64}$/);

/** Internal API. Reads need READ_TOKEN; writes need INGEST_TOKEN (which may also read). */
export function createApp({ db, blobs, readToken, ingestToken, model }: Deps) {
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

  const descriptionOf = async (jdHash: string) => {
    const blob = await blobs.get(jdKey(jdHash));
    return blob ? new TextDecoder().decode(await gunzip(blob)) : null;
  };

  // ---- reads ----------------------------------------------------------------------------
  app.get("/v1/jobs", read, zValidator("query", searchSchema), async (c) => {
    c.header("cache-control", "private, max-age=30");
    return c.json(await searchJobs(db, c.req.valid("query")));
  });

  /** The results list: a page of the database's answer to a search spec (what the assistant searched for). */
  app.post("/v1/jobs/search", read, zValidator("json", searchPageSchema), async (c) => {
    c.header("cache-control", "private, no-store");
    return c.json(await searchPage(db, c.req.valid("json")));
  });

  app.get(
    "/v1/jobs/:id",
    read,
    zValidator("param", z.object({ id: z.coerce.number().int().positive() })),
    async (c) => {
      const job = await getJob(db, c.req.valid("param").id);
      if (!job) return c.json({ error: "Not found" }, 404);
      const { jdHash: _hash, sourceHash: _source, ...rest } = job;
      c.header("cache-control", "private, max-age=300");
      return c.json({
        ...rest,
        description: await descriptionOf(job.jdHash),
        variants: await listVariants(db, job),
      });
    },
  );

  // ---- assistant -------------------------------------------------------------------------
  // The chat is stateless: the browser holds the conversation and sends it with every turn. Nothing the
  // model writes is stored. Logs carry error names only, never content.
  /** What the assistant knows about the person: the resume they built, then their own notes. */
  const aboutPerson = async () => {
    const [resume, notes] = await Promise.all([getResume(db), getProfile(db)]);
    const text = resume ? resumeToText(resume.doc.resume) : "";
    return [
      text && `# Resume\n${text}`,
      notes?.profile.trim() && `# Their notes\n${notes.profile.trim()}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  const assistant = (): LanguageModel | null => {
    try {
      return model?.() ?? null;
    } catch (error) {
      console.error(JSON.stringify({ event: "ai.misconfigured", error: errorName(error) }));
      return null;
    }
  };
  const notConfigured = {
    error: "The assistant is not configured: set OPENCODE_API_KEY and AI_MODEL_SMART.",
  };

  app.post(
    "/v1/ai/chat",
    read,
    bodyLimit({
      maxSize: CHAT_MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
    zValidator("json", z.object({ messages: z.array(z.unknown()).min(1).max(200) })),
    async (c) => {
      const llm = assistant();
      if (!llm) return c.json(notConfigured, 503);
      const agent = createJobAgent({
        model: llm,
        jobs: jobsPort(db, blobs),
        profile: await aboutPerson(),
      });
      return createAgentUIStreamResponse({
        agent,
        uiMessages: c.req.valid("json").messages,
        abortSignal: c.req.raw.signal,
        headers: { "cache-control": "private, no-store" },
        onError: (error) => {
          console.error(JSON.stringify({ event: "ai.chat.failed", error: errorName(error) }));
          return "The assistant hit an error. Try again.";
        },
      });
    },
  );

  // Personal layer: one profile per user, kept apart from the shared catalog (CLAUDE.md rule 5). v1 has one
  // user and the web app holds only the read token, so the read token may save its own profile.
  app.get("/v1/profile", read, async (c) => {
    c.header("cache-control", "private, no-store");
    return c.json(await getProfile(db));
  });

  app.put("/v1/profile", read, zValidator("json", saveProfileSchema), async (c) =>
    c.json(await saveProfile(db, c.req.valid("json"))),
  );

  app.route("/", applicationRoutes({ db, read }));

  // ---- resumes -----------------------------------------------------------------------------
  // Personal layer too. `?job=<id>` addresses the copy tailored to a posting; without it, the base resume.
  const resumeKey = zValidator(
    "query",
    z.object({ job: z.coerce.number().int().positive().optional() }),
  );

  app.get("/v1/resumes", read, async (c) => {
    c.header("cache-control", "private, no-store");
    return c.json(await listResumes(db));
  });

  app.get("/v1/resume", read, resumeKey, async (c) => {
    c.header("cache-control", "private, no-store");
    return c.json(await getResume(db, c.req.valid("query").job ?? null));
  });

  app.put(
    "/v1/resume",
    read,
    resumeKey,
    bodyLimit({
      maxSize: RESUME_MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
    zValidator("json", resumeDocSchema),
    async (c) =>
      c.json(await saveResume(db, c.req.valid("json"), c.req.valid("query").job ?? null)),
  );

  app.delete("/v1/resume", read, resumeKey, async (c) => {
    const job = c.req.valid("query").job;
    if (!job) return c.json({ error: "Only a tailored copy can be deleted." }, 400);
    await deleteResume(db, job);
    return c.body(null, 204);
  });

  /** Runs one resume model call; the browser gets a plain message, the logs get the error name only. */
  const resumeAi = async <T>(
    c: Context,
    event: string,
    run: (model: LanguageModel) => Promise<T>,
  ): Promise<Response> => {
    const llm = assistant();
    if (!llm) return c.json(notConfigured, 503);
    try {
      const result = await run(llm);
      c.header("cache-control", "private, no-store");
      return c.json(result);
    } catch (error) {
      console.error(JSON.stringify({ event, error: errorName(error) }));
      return c.json({ error: "The assistant could not do that. Try again." }, 502);
    }
  };

  const bounded = bodyLimit({
    maxSize: RESUME_MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "Request too large" }, 413),
  });

  app.post("/v1/resume/import", read, bounded, zValidator("json", importResumeSchema), (c) =>
    resumeAi(c, "ai.resume.import.failed", async (model) => ({
      resume: await importResume({
        model,
        text: c.req.valid("json").text,
        abortSignal: c.req.raw.signal,
      }),
    })),
  );

  app.post("/v1/resume/edit", read, bounded, zValidator("json", editResumeSchema), (c) =>
    resumeAi(c, "ai.resume.edit.failed", (model) =>
      editResume({ model, ...c.req.valid("json"), abortSignal: c.req.raw.signal }),
    ),
  );

  app.post(
    "/v1/resume/tailor",
    read,
    bounded,
    zValidator("json", tailorResumeSchema),
    async (c) => {
      const { jobId, resume } = c.req.valid("json");
      const job = await getJob(db, jobId);
      if (!job) return c.json({ error: "That posting is no longer listed." }, 404);
      const description = await descriptionOf(job.jdHash);
      if (!description)
        return c.json({ error: "That posting has no description to tailor to." }, 422);
      const posting = { title: job.title, company: job.company, description };
      return resumeAi(c, "ai.resume.tailor.failed", (model) =>
        tailorResume({ model, resume, posting, abortSignal: c.req.raw.signal }),
      );
    },
  );

  app.post(
    "/v1/resume/cover-letter",
    read,
    bounded,
    zValidator("json", tailorResumeSchema),
    async (c) => {
      const { jobId, resume } = c.req.valid("json");
      const job = await getJob(db, jobId);
      if (!job) return c.json({ error: "That posting is no longer listed." }, 404);
      const description = await descriptionOf(job.jdHash);
      if (!description)
        return c.json({ error: "That posting has no description to write a letter for." }, 422);
      const posting = { title: job.title, company: job.company, description };
      return resumeAi(c, "ai.resume.cover-letter.failed", async (model) => ({
        letter: await writeCoverLetter({ model, resume, posting, abortSignal: c.req.raw.signal }),
      }));
    },
  );

  app.post("/v1/resume/fit", read, bounded, zValidator("json", tailorResumeSchema), async (c) => {
    const { jobId, resume } = c.req.valid("json");
    const job = await getJob(db, jobId);
    if (!job) return c.json({ error: "That posting is no longer listed." }, 404);
    const description = await descriptionOf(job.jdHash);
    if (!description)
      return c.json({ error: "That posting has no description to check against." }, 422);
    const posting = { title: job.title, company: job.company, description };
    return resumeAi(c, "ai.resume.fit.failed", (model) =>
      fitCheck({ model, resume, posting, abortSignal: c.req.raw.signal }),
    );
  });

  app.get("/v1/sources", read, async (c) => c.json(await listSources(db)));

  /** Slim per-source view for the status page; `/v1/sources` stays the full record for the runner. */
  app.get("/v1/sources/status", read, async (c) => c.json(await listSourceStatus(db)));

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

  /**
   * Fill dedupe keys for rows stored before the key existed. Call with `after=<next>` until `more`
   * is false.
   */
  app.post(
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
   * Regroup duplicates now (`full` walks every key; the cron does the incremental pass). Call with
   * `after=<next>` until `next` is null.
   */
  app.post(
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

/** The error class only: messages can echo model output, which must never reach logs. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
