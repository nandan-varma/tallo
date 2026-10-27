import { zValidator } from "@hono/zod-validator";
import {
  editResumeSchema,
  importResumeSchema,
  resumeDocSchema,
  tailorResumeSchema,
} from "@tallo/contracts";
import {
  type BlobStore,
  type Db,
  deleteResume,
  getJob,
  getResume,
  listResumes,
  saveResume,
} from "@tallo/db";
import {
  editResume,
  fitCheck,
  importResume,
  prepInterview,
  tailorResume,
  writeCoverLetter,
} from "@tallo/resume/ai";
import type { LanguageModel } from "ai";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { RESUME_MAX_BODY_BYTES } from "./ai.ts";
import { assistant, type ModelGetter, notConfigured } from "./assistant.ts";
import { descriptionReader } from "./jobs.ts";
import { errorName } from "./util.ts";

/** Resume routes (personal layer, read token only). `?job=<id>` addresses the copy tailored to a posting. */
export function resumeRoutes({
  db,
  blobs,
  read,
  model,
}: {
  db: Db;
  blobs: BlobStore;
  read: MiddlewareHandler;
  model?: ModelGetter;
}) {
  const routes = new Hono();
  const descriptionOf = descriptionReader(blobs);
  const resumeKey = zValidator(
    "query",
    z.object({ job: z.coerce.number().int().positive().optional() }),
  );
  const bounded = bodyLimit({
    maxSize: RESUME_MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "Request too large" }, 413),
  });

  /** Runs one resume model call; the browser gets a plain message, the logs get the error name only. */
  const resumeAi = async <T>(
    c: Context,
    event: string,
    run: (model: LanguageModel) => Promise<T>,
  ): Promise<Response> => {
    const llm = assistant(model);
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

  routes.get("/v1/resumes", read, async (c) => {
    c.header("cache-control", "private, no-store");
    return c.json(await listResumes(db));
  });

  routes.get("/v1/resume", read, resumeKey, async (c) => {
    c.header("cache-control", "private, no-store");
    return c.json(await getResume(db, c.req.valid("query").job ?? null));
  });

  routes.put(
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

  routes.delete("/v1/resume", read, resumeKey, async (c) => {
    const job = c.req.valid("query").job;
    if (!job) return c.json({ error: "Only a tailored copy can be deleted." }, 400);
    await deleteResume(db, job);
    return c.body(null, 204);
  });

  routes.post("/v1/resume/import", read, bounded, zValidator("json", importResumeSchema), (c) =>
    resumeAi(c, "ai.resume.import.failed", async (model) => ({
      resume: await importResume({
        model,
        text: c.req.valid("json").text,
        abortSignal: c.req.raw.signal,
      }),
    })),
  );

  routes.post("/v1/resume/edit", read, bounded, zValidator("json", editResumeSchema), (c) =>
    resumeAi(c, "ai.resume.edit.failed", (model) =>
      editResume({ model, ...c.req.valid("json"), abortSignal: c.req.raw.signal }),
    ),
  );

  routes.post(
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

  routes.post(
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

  routes.post(
    "/v1/resume/fit",
    read,
    bounded,
    zValidator("json", tailorResumeSchema),
    async (c) => {
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
    },
  );

  routes.post(
    "/v1/resume/prep",
    read,
    bounded,
    zValidator("json", tailorResumeSchema),
    async (c) => {
      const { jobId, resume } = c.req.valid("json");
      const job = await getJob(db, jobId);
      if (!job) return c.json({ error: "That posting is no longer listed." }, 404);
      const description = await descriptionOf(job.jdHash);
      if (!description)
        return c.json({ error: "That posting has no description to prepare for." }, 422);
      const posting = { title: job.title, company: job.company, description };
      return resumeAi(c, "ai.resume.prep.failed", (model) =>
        prepInterview({ model, resume, posting, abortSignal: c.req.raw.signal }),
      );
    },
  );

  return routes;
}
