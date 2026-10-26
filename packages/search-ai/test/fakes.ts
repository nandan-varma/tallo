import { MockLanguageModelV4 } from "ai/test";
import type { Candidate, Facts, JobsPort } from "../src/types.ts";

export type Call = {
  stage: string;
  maxOutputTokens: number;
  text: string; // raw prompt text (system + user)
};

type Prompt = { role: string; content: unknown }[];

// Raw prompt text. The stage is read from the system tag "[search-ai:<stage>]".
export function promptText(prompt: unknown): string {
  return (prompt as Prompt)
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      return (message.content as { type: string; text?: string }[])
        .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
        .join("");
    })
    .join("\n");
}

export function stageOf(text: string): string {
  return /\[search-ai:(\w+)\]/.exec(text)?.[1] ?? "unknown";
}

// A reply the provider cut off at maxOutputTokens (finish "length").
export type Truncated = { truncated: string };

export function reply(text: string, finish: "stop" | "length" = "stop") {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: finish, raw: undefined },
    usage: {
      inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 7, text: 7, reasoning: undefined },
    },
    warnings: [],
  };
}

// A fake model that records every call and answers with `respond`.
export function fakeModel(
  calls: Call[],
  respond: (call: Call) => string | Truncated | Promise<string | Truncated>,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      const text = promptText(options.prompt);
      const call: Call = {
        stage: stageOf(text),
        maxOutputTokens: options.maxOutputTokens ?? -1,
        text,
      };
      calls.push(call);
      const out = await respond(call);
      return typeof out === "string" ? reply(out) : reply(out.truncated, "length");
    },
  });
}

// Ids of the postings in a triage prompt.
export function postingIds(text: string): string[] {
  const block = /<postings>(\[[\s\S]*\])<\/postings>/.exec(text)?.[1] ?? "[]";
  return (JSON.parse(block) as { id: string }[]).map((p) => p.id);
}

export function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    title: `Engineer ${id}`,
    company: "Acme",
    locations: ["Remote, US"],
    workMode: "remote",
    pay: "$150,000 - $180,000",
    postedAt: "2026-10-01",
    ...overrides,
  };
}

export function fakeJobs(args: {
  candidates: Candidate[];
  descriptions?: Record<string, string | null>;
  facts?: Record<string, Facts>;
}) {
  const descriptionCalls: string[] = [];
  const recallCalls: { queries: string[]; limit: number }[] = [];
  const port: JobsPort & { descriptionCalls: string[]; recallCalls: typeof recallCalls } = {
    descriptionCalls,
    recallCalls,
    async recall(queries, limit) {
      recallCalls.push({ queries, limit });
      return args.candidates.slice(0, limit);
    },
    async facts(ids) {
      return new Map(
        ids.filter((id) => args.facts?.[id]).map((id) => [id, args.facts?.[id] ?? {}]),
      );
    },
    async description(id) {
      descriptionCalls.push(id);
      return args.descriptions?.[id] ?? null;
    },
  };
  return port;
}

export const UNDERSTAND_REPLY = JSON.stringify({
  titles: ["Backend Engineer"],
  queries: ["backend", "typescript"],
  seniority: null,
  mustHave: [],
  dealBreakers: [],
});

export const JUDGE_REPLY = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ fit: 70, reason: "Good match", evidence: [], unknowns: [], ...overrides });

export const PROFILE =
  "# Profile\n\n- Backend engineer, 8 years, TypeScript.\n- Wants remote US roles.\n";
