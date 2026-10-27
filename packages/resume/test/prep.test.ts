import { emptyResume, type Prep, type Resume } from "@tallo/contracts";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { prepInterview } from "../src/ai.ts";
import { guardPrep } from "../src/index.ts";

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const RESUME = "Built a  Go\nservice that cut p95 latency.";

const prep = (over: Partial<Prep> = {}): Prep => ({
  questions: [
    {
      question: "Tell me about a time you cut latency.",
      angle: "Lead with the Go service and the p95 result.",
      evidence: "Built a Go service that cut p95 latency.",
    },
  ],
  ask: ["How do you measure p95 latency today?"],
  ...over,
});

describe("guardPrep", () => {
  it("keeps evidence that appears in the resume, ignoring case and extra spaces", () => {
    const out = guardPrep(prep(), RESUME);
    expect(out.questions[0]?.evidence).toBe("Built a Go service that cut p95 latency.");
  });

  it("blanks evidence the resume does not contain and keeps the question", () => {
    const out = guardPrep(
      prep({
        questions: [
          { question: "Know Rust?", angle: "Say so plainly.", evidence: "Shipped Rust." },
        ],
      }),
      RESUME,
    );
    expect(out.questions).toEqual([
      { question: "Know Rust?", angle: "Say so plainly.", evidence: "" },
    ]);
  });

  it("drops empty questions and asks", () => {
    const out = guardPrep(
      prep({
        questions: [
          { question: "  ", angle: "x", evidence: "" },
          { question: "Why this role?", angle: "Be specific.", evidence: "" },
        ],
        ask: ["", "What does success look like in six months?"],
      }),
      RESUME,
    );
    expect(out.questions.map((item) => item.question)).toEqual(["Why this role?"]);
    expect(out.ask).toEqual(["What does success look like in six months?"]);
  });

  it("caps questions at eight and questions to ask at five", () => {
    const out = guardPrep(
      prep({
        questions: Array.from({ length: 10 }, (_, i) => ({
          question: `Question ${i}`,
          angle: "a",
          evidence: "",
        })),
        ask: Array.from({ length: 7 }, (_, i) => `Ask ${i}?`),
      }),
      RESUME,
    );
    expect(out.questions).toHaveLength(8);
    expect(out.ask).toHaveLength(5);
  });
});

describe("prepInterview", () => {
  it("asks for the prep as structured output and guards its evidence", async () => {
    const seen: string[] = [];
    const answer = prep({
      questions: [
        {
          question: "Tell me about a time you cut latency.",
          angle: "Lead with the Go service.",
          evidence: "Built a Go service that cut p95 latency.",
        },
        { question: "Kubernetes experience?", angle: "Be honest.", evidence: "Ran Kubernetes." },
      ],
    });
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push(JSON.stringify(options.prompt));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(answer) }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
          warnings: [],
        } as never;
      },
    });
    const resume: Resume = { ...emptyResume(), name: "Ada", summary: RESUME };
    const out = await prepInterview({
      model,
      resume,
      posting: { title: "Backend", company: "Globex", description: "Own API latency." },
    });
    expect(out.questions).toHaveLength(2);
    expect(out.questions[0]?.evidence).toBe("Built a Go service that cut p95 latency.");
    expect(out.questions[1]?.evidence).toBe("");
    expect(out.ask).toHaveLength(1);
    expect(seen[0]).toContain("<posting>");
    expect(seen[0]).toContain("<resume>");
    expect(seen[0]).toContain("Backend at Globex");
  });
});
