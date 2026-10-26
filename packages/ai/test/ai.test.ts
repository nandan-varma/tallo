import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  createAi,
  MIN_OUTPUT_TOKENS,
  outputBudget,
  parseModelSpec,
  REASONING_RESERVE_TOKENS,
} from "../src/index.ts";

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Fake transport: records each request and answers with a canned body for the wire protocol. */
function fakeFetch(content = "hello") {
  const calls: Recorded[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body)),
    });
    const url = String(input);
    const json = url.endsWith("/messages")
      ? {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "m",
          content: [{ type: "text", text: content }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      : url.endsWith("/responses")
        ? {
            id: "resp_1",
            object: "response",
            created_at: 1,
            model: "m",
            status: "completed",
            output: [
              {
                type: "message",
                id: "msg_1",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: content, annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            incomplete_details: null,
          }
        : {
            id: "cmpl_1",
            object: "chat.completion",
            created: 1,
            model: "m",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fake as typeof fetch, calls };
}

const GO_KEY = "test-go-key";

describe("parseModelSpec", () => {
  it("splits on the first colon so model ids may contain colons", () => {
    expect(parseModelSpec("openrouter:meta/llama:free")).toEqual({
      provider: "openrouter",
      model: "meta/llama:free",
    });
  });

  it("rejects specs without a provider or a model", () => {
    expect(() => parseModelSpec("glm-5.3-flash")).toThrow(/provider:model/);
    expect(() => parseModelSpec(":glm")).toThrow(/provider:model/);
    expect(() => parseModelSpec("go:")).toThrow(/provider:model/);
  });
});

describe("outputBudget", () => {
  it("adds the reasoning reserve to the visible answer", () => {
    expect(outputBudget(2000)).toBe(2000 + REASONING_RESERVE_TOKENS);
  });

  it("never drops below the floor, so a small answer still leaves reasoning room", () => {
    expect(outputBudget(50, 0)).toBe(MIN_OUTPUT_TOKENS);
  });

  it("rejects answers and reserves that are not whole, sane numbers", () => {
    expect(() => outputBudget(0)).toThrow(RangeError);
    expect(() => outputBudget(1.5)).toThrow(RangeError);
    expect(() => outputBudget(100, -1)).toThrow(RangeError);
  });
});

describe("createAi roles", () => {
  it("names the missing env var when a role is not configured", () => {
    const ai = createAi({ env: {} });
    expect(() => ai.getModel("fast")).toThrow("AI_MODEL_FAST is not set");
    expect(() => ai.getModel("smart")).toThrow("AI_MODEL_SMART is not set");
  });

  it("fails clearly when the role's provider has no secret", () => {
    const ai = createAi({ env: { AI_MODEL_FAST: "go:glm-5.3-flash" } });
    expect(() => ai.getModel("fast")).toThrow(/AI provider "go" is not configured/);
  });

  it("does not treat Object prototype keys as configured providers", () => {
    const ai = createAi({ env: { AI_MODEL_FAST: "constructor:x", OPENAI_API_KEY: "k" } });
    expect(() => ai.getModel("fast")).toThrow(/"constructor" is not configured/);
  });
});

describe("OpenCode Go transports", () => {
  it("openai-compatible: posts to /openai/v1/chat/completions with our headers and the output budget", async () => {
    const { fetch, calls } = fakeFetch("pong");
    const ai = createAi({
      env: { OPENCODE_GO_API_KEY: GO_KEY, AI_MODEL_FAST: "go:glm-5.3-flash" },
      sessionId: "conv-1",
      fetch,
    });
    const result = await generateText({
      model: ai.getModel("fast"),
      prompt: "ping",
      maxOutputTokens: outputBudget(200),
    });

    expect(result.text).toBe("pong");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
    expect(call?.headers["user-agent"]).toMatch(/^tallo-ai\//);
    expect(call?.headers["x-opencode-session"]).toBe("conv-1");
    expect(call?.headers.authorization).toBe(`Bearer ${GO_KEY}`);
    expect(call?.body.model).toBe("glm-5.3-flash");
    expect(call?.body.max_tokens).toBe(outputBudget(200));
  });

  it("anthropic protocol: posts to /anthropic/v1/messages", async () => {
    const { fetch, calls } = fakeFetch("pong");
    const ai = createAi({
      env: { OPENCODE_GO_API_KEY: GO_KEY, AI_MODEL_SMART: "go-anthropic:claude-haiku-5-5" },
      sessionId: "conv-2",
      fetch,
    });
    await generateText({
      model: ai.getModel("smart"),
      prompt: "ping",
      maxOutputTokens: outputBudget(300),
    });

    const [call] = calls;
    expect(call?.url).toBe("https://opencode.ai/inference/go/anthropic/v1/messages");
    expect(call?.headers["x-opencode-session"]).toBe("conv-2");
    expect(call?.headers["user-agent"]).toMatch(/^tallo-ai\//);
    expect(call?.headers["x-api-key"]).toBe(GO_KEY);
    expect(call?.body.model).toBe("claude-haiku-5-5");
    expect(call?.body.max_tokens).toBe(outputBudget(300));
  });

  it("responses protocol: posts to /openai/v1/responses", async () => {
    const { fetch, calls } = fakeFetch("pong");
    const ai = createAi({
      env: { OPENCODE_GO_API_KEY: GO_KEY, AI_MODEL_FAST: "go-responses:gpt-luna" },
      sessionId: "conv-3",
      fetch,
    });
    await generateText({
      model: ai.getModel("fast"),
      prompt: "ping",
      maxOutputTokens: outputBudget(100),
    });

    const [call] = calls;
    expect(call?.url).toBe("https://opencode.ai/inference/go/openai/v1/responses");
    expect(call?.headers["x-opencode-session"]).toBe("conv-3");
    expect(call?.body.max_output_tokens).toBe(outputBudget(100));
  });

  it("keeps one session id for every call from the same instance", async () => {
    const { fetch, calls } = fakeFetch("pong");
    const ai = createAi({
      env: { OPENCODE_GO_API_KEY: GO_KEY, AI_MODEL_FAST: "go:glm-5.3-flash" },
      fetch,
    });
    const model = ai.getModel("fast");
    await generateText({ model, prompt: "one", maxOutputTokens: outputBudget(50) });
    await generateText({ model, prompt: "two", maxOutputTokens: outputBudget(50) });

    const [first, second] = calls;
    expect(first?.headers["x-opencode-session"]).toBeTruthy();
    expect(second?.headers["x-opencode-session"]).toBe(first?.headers["x-opencode-session"]);
  });

  it("gives a fresh session id to each instance when the host does not pass one", () => {
    const env = { OPENCODE_GO_API_KEY: GO_KEY, AI_MODEL_FAST: "go:glm-5.3-flash" };
    const a = createAi({ env, fetch: fakeFetch().fetch });
    const b = createAi({ env, fetch: fakeFetch().fetch });
    expect(a).not.toBe(b);
  });

  it("keeps a model id with colons intact on the wire", async () => {
    const { fetch, calls } = fakeFetch("pong");
    const ai = createAi({
      env: { OPENROUTER_API_KEY: "or-key", AI_MODEL_FAST: "openrouter:meta/llama:free" },
      fetch,
    });
    await generateText({ model: ai.getModel("fast"), prompt: "ping" });

    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]?.body.model).toBe("meta/llama:free");
  });

  it("sends Go headers only to Go, not to other providers", async () => {
    const { fetch, calls } = fakeFetch("pong");
    const ai = createAi({
      env: {
        OPENCODE_GO_API_KEY: GO_KEY,
        AI_CUSTOM_BASE_URL: "https://llm.example.test/v1",
        AI_MODEL_FAST: "custom:local-model",
      },
      fetch,
    });
    await generateText({ model: ai.getModel("fast"), prompt: "ping" });

    expect(calls[0]?.url).toBe("https://llm.example.test/v1/chat/completions");
    expect(calls[0]?.headers["x-opencode-session"]).toBeUndefined();
  });
});
