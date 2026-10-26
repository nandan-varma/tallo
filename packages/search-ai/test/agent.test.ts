import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createJobAgent, MAX_READS } from "../src/index.ts";
import type { JobHit, JobRead, JobsPort } from "../src/jobs.ts";

type LanguageModelV4CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

const hit = (id: string, over: Partial<JobHit> = {}): JobHit => ({
  id,
  title: `Backend Engineer ${id}`,
  company: "Acme",
  location: "Remote, US",
  workMode: "remote",
  pay: null,
  postedAt: "2026-10-01",
  department: null,
  ...over,
});

function port(descriptions: Record<string, string>, hits: JobHit[] = [hit("1"), hit("2")]) {
  const reads: string[] = [];
  const searches: string[][] = [];
  const jobs: JobsPort = {
    async search(queries) {
      searches.push(queries);
      return hits;
    },
    async lookup(ids) {
      return hits.filter((h) => ids.includes(h.id));
    },
    async read(id): Promise<JobRead | null> {
      reads.push(id);
      const found = hits.find((h) => h.id === id);
      if (!found || descriptions[id] === undefined) return null;
      return {
        ...found,
        applyUrl: null,
        facts: { platform: "greenhouse" },
        description: descriptions[id],
      };
    },
  };
  return { jobs, reads, searches };
}

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const calls = (...items: { name: string; input: unknown }[]) => ({
  content: items.map((item, i) => ({
    type: "tool-call" as const,
    toolCallId: `${item.name}-${i}`,
    toolName: item.name,
    input: JSON.stringify(item.input),
  })),
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});
const said = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

/** A scripted model: answers step N with script[N] and records what it was given. */
function scripted(script: ReturnType<typeof calls | typeof said>[]) {
  const seen: LanguageModelV4CallOptions[] = [];
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      seen.push(options);
      const next = script[Math.min(step, script.length - 1)];
      step += 1;
      return next as never;
    },
  });
  return { model, seen };
}

const promptText = (options: LanguageModelV4CallOptions) => JSON.stringify(options.prompt);
const toolNames = (options: LanguageModelV4CallOptions) =>
  (options.tools ?? []).map((t: { name: string }) => t.name);

const PROFILE = "# Summary\nSenior engineer. TypeScript, Postgres.";

describe("job agent", () => {
  it("searches, reads a job in full, and keeps only notes about real jobs with verbatim evidence", async () => {
    const body = `${"Intro. ".repeat(2_000)}Salary: $190,000 - $220,000 per year.\nMinimum 5 years of TypeScript.`;
    const { jobs, reads } = port({ "1": body });
    const { model, seen } = scripted([
      calls({ name: "search_jobs", input: { queries: ["backend engineer"] } }),
      calls({ name: "read_job", input: { id: "1" } }),
      calls({
        name: "explain_jobs",
        input: {
          notes: [
            {
              id: "1",
              why: "Pays well and wants TypeScript.",
              evidence: ["Salary: $190,000 - $220,000 per year.", "Free lunch every day"],
            },
            {
              id: "2",
              why: "Matches the profile.",
              evidence: ["Senior engineer. TypeScript, Postgres."],
            },
            { id: "1", why: "duplicate id", evidence: [] },
            { id: "999", why: "a job that does not exist", evidence: [] },
          ],
        },
      }),
      said("Found one."),
    ]);

    const agent = createJobAgent({ model, jobs, profile: PROFILE });
    const result = await agent.generate({ prompt: "senior backend roles" });

    expect(result.text).toBe("Found one.");
    expect(reads).toEqual(["1"]);

    // The model got the WHOLE description, bottom included.
    const afterRead = promptText(seen[2] as LanguageModelV4CallOptions);
    expect(afterRead).toContain("Minimum 5 years of TypeScript.");
    expect(afterRead.length).toBeGreaterThan(body.length);

    // The browser only learns that a read happened, never the text.
    const readResult = result.steps
      .flatMap((s) => s.toolResults)
      .find((r) => r.toolName === "read_job");
    expect(JSON.stringify(readResult?.output)).not.toContain("Minimum 5 years");
    expect(readResult?.output).toMatchObject({ found: true, id: "1", chars: body.length });

    // Notes: real jobs only, once each; a quote stays only if it is word for word in a description it read or the profile.
    const noted = result.steps
      .flatMap((s) => s.toolResults)
      .find((r) => r.toolName === "explain_jobs");
    expect(noted?.output).toEqual({
      notes: [
        {
          id: "1",
          why: "Pays well and wants TypeScript.",
          evidence: ["Salary: $190,000 - $220,000 per year."],
        },
        {
          id: "2",
          why: "Matches the profile.",
          evidence: ["Senior engineer. TypeScript, Postgres."],
        },
      ],
      dropped: 2,
    });
  });

  it("drops evidence for a job it never read", async () => {
    const { jobs } = port({ "1": "Pay: $100k" });
    const { model } = scripted([
      calls({
        name: "explain_jobs",
        input: {
          notes: [{ id: "1", why: "Looks relevant from the title.", evidence: ["Pay: $100k"] }],
        },
      }),
      said("ok"),
    ]);
    const result = await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });
    const noted = result.steps
      .flatMap((s) => s.toolResults)
      .find((r) => r.toolName === "explain_jobs");
    expect(noted?.output).toMatchObject({ notes: [{ id: "1", evidence: [] }], dropped: 0 });
  });

  it("takes read_job away after MAX_READS reads", async () => {
    const ids = Array.from({ length: MAX_READS + 2 }, (_, i) => String(i + 1));
    const { jobs } = port(
      Object.fromEntries(ids.map((id) => [id, `text ${id}`])),
      ids.map((id) => hit(id)),
    );
    const { model, seen } = scripted([
      calls(...ids.slice(0, MAX_READS).map((id) => ({ name: "read_job", input: { id } }))),
      said("done"),
    ]);

    await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });

    expect(toolNames(seen[0] as LanguageModelV4CallOptions)).toContain("read_job");
    expect(toolNames(seen[1] as LanguageModelV4CallOptions)).not.toContain("read_job");
    expect(toolNames(seen[1] as LanguageModelV4CallOptions)).toContain("search_jobs");
  });

  it("answers an unavailable job without throwing", async () => {
    const { jobs } = port({});
    const { model } = scripted([calls({ name: "read_job", input: { id: "404" } }), said("none")]);
    const result = await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });
    const read = result.steps.flatMap((s) => s.toolResults).find((r) => r.toolName === "read_job");
    expect(read?.output).toEqual({ found: false, id: "404" });
  });

  it("tells the model the profile is data and includes it; says so when there is none", async () => {
    const { jobs } = port({});
    const withProfile = scripted([said("hi")]);
    await createJobAgent({ model: withProfile.model, jobs, profile: PROFILE }).generate({
      prompt: "x",
    });
    const system = promptText(withProfile.seen[0] as LanguageModelV4CallOptions);
    expect(system).toContain("<profile>");
    expect(system).toContain("TypeScript, Postgres");

    const without = scripted([said("hi")]);
    await createJobAgent({ model: without.model, jobs, profile: "  " }).generate({ prompt: "x" });
    expect(promptText(without.seen[0] as LanguageModelV4CallOptions)).toContain(
      "No profile is saved yet",
    );
  });

  it("asks the provider for no reasoning", async () => {
    const { jobs } = port({});
    const { model, seen } = scripted([said("hi")]);
    await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });
    expect(seen[0]?.reasoning).toBe("none");
  });
});
