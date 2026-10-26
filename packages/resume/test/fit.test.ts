import { emptyResume, type Fit, type Resume } from "@tallo/contracts";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { fitCheck } from "../src/ai.ts";
import { guardFit } from "../src/index.ts";

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const RESUME = "Built a  Go\nservice that cut p95 latency.";
const POSTING = "Five years of experience with Kubernetes.\nOwn   API latency.";

const fit = (over: Partial<Fit> = {}): Fit => ({
  verdict: "good",
  summary: "Solid backend record. Kubernetes is missing.",
  matches: [
    { requirement: "Own API latency.", evidence: "Built a Go service that cut p95 latency." },
  ],
  gaps: [
    {
      requirement: "Five years of experience with Kubernetes.",
      advice: "Not covered in your resume.",
    },
  ],
  ...over,
});

describe("guardFit", () => {
  it("keeps quotes that appear in the posting and the resume, ignoring case and extra spaces", () => {
    const out = guardFit(fit(), RESUME, POSTING);
    expect(out.matches).toHaveLength(1);
    expect(out.gaps).toHaveLength(1);
    expect(out.verdict).toBe("good");
  });

  it("drops a match whose requirement or evidence the texts do not contain", () => {
    const out = guardFit(
      fit({
        matches: [
          { requirement: "Own API latency.", evidence: "Ran a Kubernetes cluster." },
          { requirement: "Knows Rust.", evidence: "Built a Go service that cut p95 latency." },
        ],
      }),
      RESUME,
      POSTING,
    );
    expect(out.matches).toEqual([]);
  });

  it("drops a gap whose requirement the posting does not contain", () => {
    const out = guardFit(
      fit({ gaps: [{ requirement: "Requires a PhD.", advice: "Not covered in your resume." }] }),
      RESUME,
      POSTING,
    );
    expect(out.gaps).toEqual([]);
  });

  it("drops empty quotes, which every text contains", () => {
    const out = guardFit(
      fit({
        matches: [{ requirement: "  ", evidence: "" }],
        gaps: [{ requirement: "", advice: "x" }],
      }),
      RESUME,
      POSTING,
    );
    expect(out.matches).toEqual([]);
    expect(out.gaps).toEqual([]);
  });

  it("caps both lists at six", () => {
    const many = Array.from({ length: 9 }, () => ({
      requirement: "Own API latency.",
      evidence: "Built a Go service that cut p95 latency.",
    }));
    const gaps = Array.from({ length: 9 }, () => ({
      requirement: "Own API latency.",
      advice: "Not covered in your resume.",
    }));
    const out = guardFit(fit({ matches: many, gaps }), RESUME, POSTING);
    expect(out.matches).toHaveLength(6);
    expect(out.gaps).toHaveLength(6);
  });
});

describe("fitCheck", () => {
  it("asks for the fit as structured output and guards its quotes", async () => {
    const seen: string[] = [];
    const answer = fit({
      matches: [
        { requirement: "Own API latency.", evidence: "Built a Go service that cut p95 latency." },
        { requirement: "Own API latency.", evidence: "Invented evidence." },
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
    const resume: Resume = {
      ...emptyResume(),
      name: "Ada",
      summary: "Built a Go service that cut p95 latency.",
    };
    const out = await fitCheck({
      model,
      resume,
      posting: { title: "Backend", company: "Globex", description: POSTING },
    });
    expect(out.verdict).toBe("good");
    expect(out.matches).toHaveLength(1);
    expect(out.gaps).toHaveLength(1);
    expect(seen[0]).toContain("<posting>");
    expect(seen[0]).toContain("<resume>");
    expect(seen[0]).toContain("Own   API latency.");
  });
});
