import { zValidator } from "@hono/zod-validator";
import { saveProfileSchema } from "@tallo/contracts";
import { type BlobStore, type Db, getProfile, getResume, saveProfile } from "@tallo/db";
import { resumeToText } from "@tallo/resume";
import { createJobAgent } from "@tallo/search-ai";
import { createAgentUIStreamResponse, type LanguageModel } from "ai";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { CHAT_MAX_BODY_BYTES } from "./ai.ts";
import { jobsPort } from "./jobs-port.ts";
import { errorName } from "./util.ts";

export type ModelGetter = () => LanguageModel | null;

export const notConfigured = {
  error: "The assistant is not configured: set OPENCODE_API_KEY and AI_MODEL_SMART.",
};

/** The model, or null. A misconfigured model is logged by error name and treated as not configured. */
export function assistant(model?: ModelGetter): LanguageModel | null {
  try {
    return model?.() ?? null;
  } catch (error) {
    console.error(JSON.stringify({ event: "ai.misconfigured", error: errorName(error) }));
    return null;
  }
}

/** What the assistant knows about the person: the resume they built, then their own notes. */
const aboutPerson = async (db: Db) => {
  const [resume, notes] = await Promise.all([getResume(db), getProfile(db)]);
  const text = resume ? resumeToText(resume.doc.resume) : "";
  return [
    text && `# Resume\n${text}`,
    notes?.profile.trim() && `# Their notes\n${notes.profile.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

/**
 * The chat is stateless: the browser holds the conversation and sends it with every turn, and
 * nothing the model writes is stored. The profile is the personal layer (CLAUDE.md rule 5); v1 has
 * one user and the web app holds only the read token, so the read token may save its own profile.
 */
export function assistantRoutes({
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

  routes.post(
    "/v1/ai/chat",
    read,
    bodyLimit({
      maxSize: CHAT_MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
    zValidator("json", z.object({ messages: z.array(z.unknown()).min(1).max(200) })),
    async (c) => {
      const llm = assistant(model);
      if (!llm) return c.json(notConfigured, 503);
      const agent = createJobAgent({
        model: llm,
        jobs: jobsPort(db, blobs),
        profile: await aboutPerson(db),
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

  routes.get("/v1/profile", read, async (c) => {
    c.header("cache-control", "private, no-store");
    return c.json(await getProfile(db));
  });

  routes.put("/v1/profile", read, zValidator("json", saveProfileSchema), async (c) =>
    c.json(await saveProfile(db, c.req.valid("json"))),
  );

  return routes;
}
