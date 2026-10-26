import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createProviderRegistry, type LanguageModel } from "ai";
import { type AiEnv, parseModelSpec, ROLE_ENV, type Role } from "./config.ts";

/** OpenCode Go gateway. Each wire protocol lives under its own path prefix. */
export const GO_BASE_URL = "https://opencode.ai/inference/go";
export const USER_AGENT = "tallo-ai/0.0.0 (+https://github.com/nandan-varma/tallo)";

type Providers = Parameters<typeof createProviderRegistry>[0];

export interface AiOptions {
  env: AiEnv;
  /** Stable per conversation; sent as `x-opencode-session` on Go requests. Defaults to a fresh id. */
  sessionId?: string;
  /** Outbound fetch for every provider. Tests pass a fake here; production leaves it unset. */
  fetch?: typeof fetch;
}

export interface Ai {
  /** Resolves a role (`fast` | `smart`) to the model configured in `AI_MODEL_FAST` / `AI_MODEL_SMART`. */
  getModel(role: Role): LanguageModel;
}

function withUserAgent(base: typeof fetch | undefined): typeof fetch {
  const inner = base ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("user-agent", USER_AGENT);
    return inner(input, { ...init, headers });
  };
}

/**
 * Builds a provider registry from env. A provider is registered only when its secret (or base URL,
 * for `custom`) is present, so an unconfigured provider fails with a clear error, not a 401.
 */
export function createAi({ env, sessionId = crypto.randomUUID(), fetch }: AiOptions): Ai {
  const providers: Providers = {};

  if (env.OPENCODE_API_KEY) {
    const apiKey = env.OPENCODE_API_KEY;
    // The SDK builds its own User-Agent after config headers, so ours is set on the wire
    // by a fetch wrapper, which runs last. The session header is stable per conversation.
    const goFetch = withUserAgent(fetch);
    const headers = { "x-opencode-session": sessionId };
    providers.go = createOpenAICompatible({
      name: "go",
      baseURL: `${GO_BASE_URL}/openai/v1`,
      apiKey,
      headers,
      fetch: goFetch,
    });
    providers["go-anthropic"] = createAnthropic({
      baseURL: `${GO_BASE_URL}/anthropic/v1`,
      apiKey,
      headers,
      fetch: goFetch,
    });
    providers["go-responses"] = createOpenAI({
      baseURL: `${GO_BASE_URL}/openai/v1`,
      apiKey,
      headers,
      fetch: goFetch,
    });
  }
  if (env.OPENAI_API_KEY) {
    providers.openai = createOpenAI({ apiKey: env.OPENAI_API_KEY, fetch });
  }
  if (env.ANTHROPIC_API_KEY) {
    providers.anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY, fetch });
  }
  if (env.OPENROUTER_API_KEY) {
    providers.openrouter = createOpenAICompatible({
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: env.OPENROUTER_API_KEY,
      fetch,
    });
  }
  if (env.AI_CUSTOM_BASE_URL) {
    providers.custom = createOpenAICompatible({
      name: "custom",
      baseURL: env.AI_CUSTOM_BASE_URL,
      apiKey: env.AI_CUSTOM_API_KEY,
      fetch,
    });
  }

  const registry = createProviderRegistry(providers);

  return {
    getModel(role) {
      const raw = env[ROLE_ENV[role]];
      if (!raw) {
        throw new Error(`${ROLE_ENV[role]} is not set (expected "provider:model")`);
      }
      const { provider, model } = parseModelSpec(raw);
      if (!Object.hasOwn(providers, provider)) {
        const configured = Object.keys(providers).join(", ") || "none";
        throw new Error(
          `AI provider "${provider}" is not configured (its secret is missing); configured: ${configured}`,
        );
      }
      return registry.languageModel(`${provider}:${model}`);
    },
  };
}
