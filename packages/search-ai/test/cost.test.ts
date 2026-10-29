import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  createJobAgent,
  fitMessages,
  MAX_STEPS,
  READ_MAX_CHARS,
  recentTurns,
  STEP_OUTPUT_TOKENS,
  TURN_INPUT_TOKENS,
} from "../src/index.ts";
import type { JobHit, JobsPort } from "../src/jobs.ts";

type Options = Parameters<MockLanguageModelV4["doGenerate"]>[0];

const hit: JobHit = {
  id: "1",
  title: "Backend Engineer",
  company: "Acme",
  location: "Remote",
  workMode: "remote",
  pay: null,
  postedAt: "2026-10-01",
  department: null,
  locations: 1,
};
const jobs = (description: string): JobsPort => ({
  search: async () => [hit],
  lookup: async () => [hit],
  read: async () => ({ ...hit, applyUrl: null, facts: {}, description }),
});

const usage = (input: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
});
const toolCall = (name: string, input: unknown, tokens = 5) => ({
  content: [
    { type: "tool-call" as const, toolCallId: name, toolName: name, input: JSON.stringify(input) },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: usage(tokens),
  warnings: [],
});
const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: usage(5),
  warnings: [],
});

function scripted(script: unknown[]) {
  const seen: Options[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      seen.push(options);
      return script[Math.min(seen.length - 1, script.length - 1)] as never;
    },
  });
  return { model, seen };
}
const prompt = (o: Options) => JSON.stringify(o.prompt);

describe("description clipping", () => {
  it("marks the cut, keeps both ends and bounds one read", async () => {
    const body = `START ${"filler ".repeat(10_000)} Salary: $200,000 per year. END`;
    const { model, seen } = scripted([toolCall("read_job", { id: "1" }), text("ok")]);
    await createJobAgent({ model, jobs: jobs(body), profile: "" }).generate({ prompt: "x" });
    const afterRead = prompt(seen[1] as Options);
    expect(afterRead).toContain("START");
    expect(afterRead).toContain("Salary: $200,000 per year. END");
    expect(afterRead).toMatch(/characters left out here/);
    expect(afterRead).toContain("the middle is cut where marked");
    expect(afterRead.length).toBeLessThan(READ_MAX_CHARS * 1.5);
  });

  it("does not mark a description that fits", async () => {
    const { model, seen } = scripted([toolCall("read_job", { id: "1" }), text("ok")]);
    await createJobAgent({ model, jobs: jobs("Short posting."), profile: "" }).generate({
      prompt: "x",
    });
    expect(prompt(seen[1] as Options)).not.toMatch(/left out here/);
  });
});

describe("request ceilings", () => {
  it("caps output per call and marks the stable prefix for the provider's prompt cache", async () => {
    const { model, seen } = scripted([text("ok")]);
    await createJobAgent({ model, jobs: jobs(""), profile: "" }).generate({ prompt: "x" });
    const call = seen[0] as Options;
    expect(call.maxOutputTokens).toBe(STEP_OUTPUT_TOKENS);
    const system = (call.prompt as { role: string; providerOptions?: unknown }[])[0];
    expect(system?.role).toBe("system");
    expect(system?.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    const last = (call.prompt as { providerOptions?: unknown }[]).at(-1);
    expect(last?.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("stops after MAX_STEPS model calls however long the model keeps searching", async () => {
    const { model, seen } = scripted([toolCall("search_jobs", { queries: ["engineer"] })]);
    await createJobAgent({ model, jobs: jobs(""), profile: "" }).generate({ prompt: "x" });
    expect(seen.length).toBeLessThanOrEqual(MAX_STEPS);
  });

  it("takes the tools away once a message has spent its input budget", async () => {
    const { model, seen } = scripted([
      toolCall("search_jobs", { queries: ["engineer"] }, TURN_INPUT_TOKENS),
      text("done"),
    ]);
    await createJobAgent({ model, jobs: jobs(""), profile: "" }).generate({ prompt: "x" });
    expect(((seen[0] as Options).tools ?? []).length).toBeGreaterThan(0);
    expect((seen[1] as Options).tools ?? []).toHaveLength(0);
  });
});

describe("context fitting", () => {
  const toolMessage = (id: string, body: string): ModelMessage => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "search_jobs",
        output: { type: "text", value: body },
      },
    ],
  });

  it("replaces the oldest results with a marker and keeps the newest", () => {
    const big = "x".repeat(40_000);
    const messages: ModelMessage[] = [
      { role: "user", content: "a" },
      toolMessage("1", big),
      toolMessage("2", big),
      toolMessage("3", "newest"),
    ];
    const fitted = JSON.stringify(fitMessages(messages, 5_000));
    expect(fitted).toContain("Earlier search results, left out");
    expect(fitted).toContain("newest");
    expect(fitted).not.toContain(big);
    expect(fitMessages(messages.slice(0, 1), 5_000)).toEqual(messages.slice(0, 1));
  });

  it("keeps the last turns, starting at a user message", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      i,
    }));
    const kept = recentTurns(history, 5);
    expect(kept[0]?.role).toBe("user");
    expect(kept.at(-1)?.i).toBe(9);
    expect(recentTurns(history.slice(0, 3), 40)).toHaveLength(3);
  });
});
