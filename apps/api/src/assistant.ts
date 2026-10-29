import { zValidator } from "@hono/zod-validator";
import { type Budget, exhausted, meter, meteredModel, type Role, settle } from "@tallo/ai";
import { saveProfileSchema } from "@tallo/contracts";
import { type BlobStore, type Db, getProfile, getResume, saveProfile } from "@tallo/db";
import { resumeToText } from "@tallo/resume";
import { createJobAgent, recentTurns } from "@tallo/search-ai";
import { createAgentUIStreamResponse, type LanguageModel } from "ai";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { CHAT_MAX_BODY_BYTES } from "./ai.ts";
import { jobsPort } from "./jobs-port.ts";
import { errorName } from "./util.ts";

export type ModelGetter = (role: Role) => LanguageModel | null;

/** What a route needs to call a model: where to get one per role, and the day's token ceiling. */
export interface AiAccess {
  model?: ModelGetter;
  budget?: () => Budget;
}

export const notConfigured = {
  error: "The assistant is not configured: set OPENCODE_API_KEY and AI_MODEL_SMART.",
};

/** The model and the budget, or null. A misconfiguration is logged by error name and treated as not configured. */
function configured({ model, budget }: AiAccess, role: Role) {
  try {
    const llm = model?.(role) ?? null;
    return llm && budget ? { llm, budget: budget() } : null;
  } catch (error) {
    console.error(JSON.stringify({ event: "ai.misconfigured", error: errorName(error) }));
    return null;
  }
}

/** One AI request in flight: a metered model, and `done` to call once when the request ends. */
export interface Gate {
  model: LanguageModel;
  done(): Promise<void>;
}

const secondsToUtcMidnight = (now: Date) =>
  Math.ceil(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - +now) / 1000,
  );

/**
 * Starts an AI request: 503 when no model is configured, 429 when today's token ceiling is already spent, else a
 * model that counts what it spends. `done` logs the usage and adds it to the day's ledger; a ledger failure is
 * logged and never fails the answer the person already has.
 */
export async function openGate(
  c: Context,
  access: AiAccess,
  role: Role,
  feature: string,
): Promise<Gate | Response> {
  const setup = configured(access, role);
  if (!setup) return c.json(notConfigured, 503);
  const now = new Date();
  if (await exhausted(setup.budget, now)) {
    console.error(
      JSON.stringify({ event: "ai.budget.exhausted", feature, limit: setup.budget.limit }),
    );
    c.header("retry-after", String(secondsToUtcMidnight(now)));
    return c.json({ error: "Today's assistant budget is used up. It resets at 00:00 UTC." }, 429);
  }
  const m = meter();
  return {
    model: meteredModel(setup.llm, m),
    done: () =>
      settle(feature, setup.llm, m, setup.budget.ledger).catch((error) =>
        console.error(
          JSON.stringify({ event: "ai.usage.unrecorded", feature, error: errorName(error) }),
        ),
      ),
  };
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
  ai,
}: {
  db: Db;
  blobs: BlobStore;
  read: MiddlewareHandler;
  ai: AiAccess;
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
      const gate = await openGate(c, ai, "smart", "chat");
      if (gate instanceof Response) return gate;
      const agent = createJobAgent({
        model: gate.model,
        jobs: jobsPort(db, blobs),
        profile: await aboutPerson(db),
      });
      return createAgentUIStreamResponse({
        agent,
        // The browser sends the whole conversation; the model sees only its recent turns.
        uiMessages: recentTurns(c.req.valid("json").messages as { role: string }[]),
        abortSignal: c.req.raw.signal,
        headers: { "cache-control": "private, no-store" },
        // Runs when the stream ends, aborted or not: what was spent is counted either way.
        onFinish: () => gate.done(),
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
