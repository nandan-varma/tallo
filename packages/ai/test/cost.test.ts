import { generateText, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  cachedSystem,
  clip,
  DEFAULT_DAILY_TOKEN_LIMIT,
  dailyTokenLimit,
  exhausted,
  kvLedger,
  memoryLedger,
  meter,
  meteredModel,
  settle,
  withBreakpoint,
} from "../src/index.ts";

describe("clip", () => {
  it("returns text within the limit unchanged", () => {
    expect(clip("short", 100)).toBe("short");
  });

  it("keeps the start and the end, and says how much was left out", () => {
    const text = `HEAD${"x".repeat(1000)}TAIL`;
    const out = clip(text, 100);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toMatch(/\[\.\.\. 9\d\d characters left out here/);
    expect(out.length).toBeLessThan(text.length / 4);
  });

  it("rejects a limit that is not a positive whole number", () => {
    expect(() => clip("a", 0)).toThrow(RangeError);
    expect(() => clip("a", 1.5)).toThrow(RangeError);
  });
});

describe("daily budget", () => {
  it("parses the limit, defaults when unset, and fails loudly on junk", () => {
    expect(dailyTokenLimit(undefined)).toBe(DEFAULT_DAILY_TOKEN_LIMIT);
    expect(dailyTokenLimit("500")).toBe(500);
    expect(() => dailyTokenLimit("lots")).toThrow(RangeError);
    expect(() => dailyTokenLimit("-1")).toThrow(RangeError);
  });

  it("memory ledger counts per day and forgets the previous day", async () => {
    const ledger = memoryLedger();
    await ledger.add("2026-10-01", 40);
    await ledger.add("2026-10-01", 2);
    expect(await ledger.used("2026-10-01")).toBe(42);
    await ledger.add("2026-10-02", 1);
    expect(await ledger.used("2026-10-01")).toBe(0);
    expect(await ledger.used("2026-10-02")).toBe(1);
  });

  it("kv ledger stores one expiring key per day", async () => {
    const store = new Map<string, string>();
    const ttl: Array<number | undefined> = [];
    const ledger = kvLedger({
      get: async (key) => store.get(key) ?? null,
      put: async (key, value, options) => {
        store.set(key, value);
        ttl.push(options?.expirationTtl);
      },
    });
    await ledger.add("2026-10-01", 5);
    await ledger.add("2026-10-01", 7);
    expect(store.get("ai-spend:2026-10-01")).toBe("12");
    expect(await ledger.used("2026-10-01")).toBe(12);
    expect(ttl.every((t) => (t ?? 0) >= 86_400)).toBe(true);
  });

  it("is exhausted exactly at the limit", async () => {
    const ledger = memoryLedger();
    const now = new Date("2026-10-01T12:00:00Z");
    await ledger.add("2026-10-01", 99);
    expect(await exhausted({ ledger, limit: 100 }, now)).toBe(false);
    await ledger.add("2026-10-01", 1);
    expect(await exhausted({ ledger, limit: 100 }, now)).toBe(true);
  });
});

describe("prompt cache markers", () => {
  const marked = (m: ModelMessage) => m.providerOptions?.anthropic !== undefined;

  it("marks the system prefix", () => {
    expect(marked(cachedSystem("rules"))).toBe(true);
  });

  it("keeps a single breakpoint, on the last message, and leaves the input alone", () => {
    const input: ModelMessage[] = [
      cachedSystem("rules"),
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const out = withBreakpoint(input);
    expect(out.map(marked)).toEqual([false, false, false, true]);
    expect(marked(input[0] as ModelMessage)).toBe(true);
    expect(withBreakpoint([])).toEqual([]);
  });
});

describe("metering", () => {
  const usage = {
    inputTokens: { total: 100, noCache: 20, cacheRead: 80, cacheWrite: 0 },
    outputTokens: { total: 7, text: 7, reasoning: undefined },
  };
  const model = () =>
    new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [{ type: "text", text: "hi" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        }) as never,
    });

  it("sums input, cached input and output over calls, and logs one line when settled", async () => {
    const m = meter();
    const wrapped = meteredModel(model(), m);
    await generateText({ model: wrapped, prompt: "one" });
    await generateText({ model: wrapped, prompt: "two" });
    expect(m).toMatchObject({ steps: 2, input: 200, cached: 160, output: 14, total: 214 });

    const ledger = memoryLedger();
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => void logs.push(line);
    try {
      await settle("test", wrapped, m, ledger, new Date("2026-10-01T00:00:00Z"));
    } finally {
      console.log = spy;
    }
    expect(await ledger.used("2026-10-01")).toBe(214);
    expect(JSON.parse(logs[0] as string)).toMatchObject({
      event: "ai.usage",
      feature: "test",
      cached: 160,
    });
  });

  it("records nothing for a request that made no model call", async () => {
    const ledger = memoryLedger();
    await settle("test", model(), meter(), ledger, new Date("2026-10-01T00:00:00Z"));
    expect(await ledger.used("2026-10-01")).toBe(0);
  });
});
