import { type AiEnv, createAi } from "@tallo/ai";
import type { LanguageModel } from "ai";

/**
 * The assistant's model, from the Worker env. Returns null when no OpenCode key is set, so the route
 * answers 503. An unset or unknown `AI_MODEL_SMART` throws; the route turns that into 503 too.
 */
export function assistantModel(env: AiEnv): LanguageModel | null {
  if (!env.OPENCODE_API_KEY) return null;
  return createAi({ env }).getModel("smart");
}

/** Chat request body cap: a long conversation with tool outputs still fits well inside this. */
export const CHAT_MAX_BODY_BYTES = 512 * 1024;
/** A resume plus its style is a few KB; a pasted resume is capped at 60k characters. */
export const RESUME_MAX_BODY_BYTES = 256 * 1024;
