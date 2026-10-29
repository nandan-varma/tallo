import {
  type AiEnv,
  type Budget,
  createAi,
  dailyTokenLimit,
  type KeyValue,
  kvLedger,
  memoryLedger,
  type Role,
} from "@tallo/ai";
import type { LanguageModel } from "ai";

/** What the Worker adds to the AI env: an optional KV namespace for the daily ledger (see docs/ai-search.md). */
export interface AiBindings extends AiEnv {
  AI_SPEND?: KeyValue;
}

/**
 * The model for a role, from the Worker env. Returns null when no OpenCode key is set, so the route answers 503.
 * `fast` falls back to `smart` while `AI_MODEL_FAST` is unset, so cheap routing is opt-in by config alone. An unset
 * `AI_MODEL_SMART` or an unknown provider throws; the route turns that into 503 too.
 */
export function assistantModel(env: AiEnv, role: Role = "smart"): LanguageModel | null {
  if (!env.OPENCODE_API_KEY) return null;
  const ai = createAi({ env });
  return ai.getModel(role === "fast" && env.AI_MODEL_FAST ? "fast" : "smart");
}

const isolateLedger = memoryLedger();

/**
 * The daily token ceiling: KV when `AI_SPEND` is bound (shared by every isolate), else this isolate's memory.
 * Called per AI request, so a bad `AI_DAILY_TOKEN_LIMIT` fails the AI routes (503), not the whole Worker.
 */
export function assistantBudget(env: AiBindings): Budget {
  return {
    ledger: env.AI_SPEND ? kvLedger(env.AI_SPEND) : isolateLedger,
    limit: dailyTokenLimit(env.AI_DAILY_TOKEN_LIMIT),
  };
}

/** Chat request body cap: a long conversation with tool outputs still fits well inside this. */
export const CHAT_MAX_BODY_BYTES = 512 * 1024;
/** A resume plus its style is a few KB; a pasted resume is capped at 60k characters. */
export const RESUME_MAX_BODY_BYTES = 256 * 1024;
