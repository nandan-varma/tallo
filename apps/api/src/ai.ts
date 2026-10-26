import { type AiEnv, createAi } from "@tallo/ai";
import type { Models } from "@tallo/search-ai";

/**
 * Model roles from the Worker env. Returns null when no OpenCode key is set, so the route answers 503.
 * An unset or unknown `AI_MODEL_*` throws; the route turns that into 503 too.
 */
export function modelsFromEnv(env: AiEnv): Models | null {
  if (!env.OPENCODE_API_KEY) return null;
  const ai = createAi({ env });
  return { fast: ai.getModel("fast"), smart: ai.getModel("smart") };
}

/**
 * Ceiling on model calls for one ask, retries included. The default search (300 candidates, 15 deep
 * reads, long descriptions) can need more; a search past the ceiling fails loudly instead of running on.
 */
export const AI_MAX_MODEL_CALLS = 60;
/** Request body cap. A 20k-char profile plus a query fits well inside this. */
export const AI_MAX_BODY_BYTES = 128 * 1024;
