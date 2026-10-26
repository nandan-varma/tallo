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
 * Ceiling on model calls for one ask, retries included. Worst default ask: 1 understand, 3 triage
 * batches (300 candidates at 100 per batch), and 15 deep reads of up to 8 parts each, where each read
 * is 8 notes calls plus 1 judge call: 1 + 3 + 15 x 9 = 139. The ceiling is 150, so that ask fits with
 * 11 calls to spare. A search past the ceiling fails loudly instead of running on.
 */
export const AI_MAX_MODEL_CALLS = 150;
/** Request body cap. A 20k-char profile plus a query fits well inside this. */
export const AI_MAX_BODY_BYTES = 128 * 1024;
