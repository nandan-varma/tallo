/** Model roles the rest of the code asks for. Code never names a provider. */
export const ROLES = ["fast", "smart"] as const;
export type Role = (typeof ROLES)[number];

/** Environment read by `createAi`. Secrets are Worker secrets or `.env` values, never committed. */
export interface AiEnv {
  /** `provider:model` for the `fast` role, e.g. `go:glm-5.3-flash`. */
  AI_MODEL_FAST?: string;
  /** `provider:model` for the `smart` role, e.g. `go-anthropic:claude-haiku-5-5`. */
  AI_MODEL_SMART?: string;
  OPENCODE_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Any OpenAI-compatible endpoint, e.g. `https://host/v1`. */
  AI_CUSTOM_BASE_URL?: string;
  AI_CUSTOM_API_KEY?: string;
  /** Tokens (input plus output) the assistant may spend per UTC day. Unset uses `DEFAULT_DAILY_TOKEN_LIMIT`. */
  AI_DAILY_TOKEN_LIMIT?: string;
}

/** Input and output tokens per UTC day. At $1/M input (unverified list price) it is about $2 if every token were input; see docs/ai-search.md. */
export const DEFAULT_DAILY_TOKEN_LIMIT = 2_000_000;

/** Parses `AI_DAILY_TOKEN_LIMIT`. A bad value throws: a budget that is silently ignored is worse than a loud error. */
export function dailyTokenLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_TOKEN_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`AI_DAILY_TOKEN_LIMIT must be a positive integer, got "${raw}"`);
  }
  return limit;
}

export const ROLE_ENV = {
  fast: "AI_MODEL_FAST",
  smart: "AI_MODEL_SMART",
} as const satisfies Record<Role, keyof AiEnv>;

export interface ModelSpec {
  provider: string;
  model: string;
}

/** Splits `provider:model` on the first colon, so model ids may contain colons (`org/model:free`). */
export function parseModelSpec(spec: string): ModelSpec {
  const at = spec.indexOf(":");
  const provider = at > 0 ? spec.slice(0, at).trim() : "";
  const model = at > 0 ? spec.slice(at + 1).trim() : "";
  if (!provider || !model) {
    throw new Error(`Model spec must be "provider:model", got "${spec}"`);
  }
  return { provider, model };
}

/** Hidden reasoning tokens reserved on top of the visible answer for reasoning models. */
export const REASONING_RESERVE_TOKENS = 4096;
/** Floor so a tiny answer budget never starves a reasoning model into empty content. */
export const MIN_OUTPUT_TOKENS = 1024;

/**
 * Explicit `maxOutputTokens` for one call: the visible answer plus room for reasoning.
 * Reasoning models spend `max_tokens` on hidden reasoning first and can return empty
 * content when the budget runs out inside it, so every call passes this, never a bare number.
 */
export function outputBudget(
  answerTokens: number,
  reasoningTokens: number = REASONING_RESERVE_TOKENS,
): number {
  if (!Number.isInteger(answerTokens) || answerTokens <= 0) {
    throw new RangeError(`answerTokens must be a positive integer, got ${answerTokens}`);
  }
  if (!Number.isInteger(reasoningTokens) || reasoningTokens < 0) {
    throw new RangeError(`reasoningTokens must be a non-negative integer, got ${reasoningTokens}`);
  }
  return Math.max(MIN_OUTPUT_TOKENS, answerTokens + reasoningTokens);
}
