import type { SearchSpec } from "@tallo/contracts";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createJobAgent, MAX_READS } from "../src/index.ts";
import type { JobHit, JobRead, JobsPort } from "../src/jobs.ts";
import { createTools } from "../src/tools.ts";

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
  locations: 1,
  ...over,
});

function port(descriptions: Record<string, string>, hits: JobHit[] = [hit("1"), hit("2")]) {
  const reads: string[] = [];
  const searches: { spec: SearchSpec; limit: number }[] = [];
  const jobs: JobsPort = {
    async search(spec, limit) {
      searches.push({ spec, limit });
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
    input: JSON.stringify(
      item.name === "publish_jobs"
        ? { search: { queries: ["software engineer"] }, ...(item.input as object) }
        : item.input,
    ),
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

  it("keeps publication available after MAX_READS reads and refuses additional fetches", async () => {
    const ids = Array.from({ length: MAX_READS + 2 }, (_, i) => String(i + 1));
    const { jobs, reads } = port(
      Object.fromEntries(ids.map((id) => [id, `text ${id}`])),
      ids.map((id) => hit(id)),
    );
    const { model, seen } = scripted([
      calls(...ids.map((id) => ({ name: "read_job", input: { id } }))),
      said("done"),
    ]);

    await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });

    expect(toolNames(seen[0] as LanguageModelV4CallOptions)).toContain("read_job");
    expect(reads).toHaveLength(MAX_READS);
    expect(toolNames(seen[1] as LanguageModelV4CallOptions)).toContain("publish_jobs");
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

  it("describes an unfiltered catalog: the model judges relevance, place and pay; unknown stays unknown", async () => {
    const { jobs } = port({});
    const { model, seen } = scripted([said("hi")]);
    await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });
    const call = seen[0] as LanguageModelV4CallOptions;
    const system = promptText(call);
    expect(system).not.toMatch(/US tech|tech jobs/);
    expect(system).toContain("nothing is pre-filtered");
    expect(system).toContain("The database matches title words, not qualifications");
    expect(system).toContain("A field the line does not show is UNKNOWN");
    expect(system).toContain("never present a converted figure as the source's");
    const search = call.tools?.find((t) => t.name === "search_jobs");
    expect(JSON.stringify(search)).not.toMatch(/US tech/);
  });

  it("asks the provider for no reasoning", async () => {
    const { jobs } = port({});
    const { model, seen } = scripted([said("hi")]);
    await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });
    expect(seen[0]?.reasoning).toBe("none");
  });

  it("passes the whole spec to the port, with the person's own words, and asks for the search limit", async () => {
    const { jobs, searches } = port({});
    const { model } = scripted([
      calls({
        name: "search_jobs",
        input: {
          queries: ["stripe software engineer"],
          companies: ["Stripe"],
          locations: ["NYC", "remote"],
        },
      }),
      said("ok"),
    ]);
    await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });
    expect(searches).toEqual([
      {
        spec: {
          queries: ["stripe software engineer"],
          companies: ["Stripe"],
          locations: ["NYC", "remote"],
        },
        limit: 40,
      },
    ]);
  });

  it("gives the model one line per hit, with unknown fields left out, and keeps the structured hits for the browser", async () => {
    const hits = [
      hit("7", {
        title: "Data Engineer",
        company: "Acme",
        location: "Seattle, WA",
        workMode: "onsite",
        pay: "USD 150000-180000 per year",
        postedAt: "2026-10-02",
        department: null,
      }),
      hit("8", {
        title: "Data Engineer",
        company: "Acme",
        location: null,
        workMode: null,
        pay: null,
        postedAt: null,
        department: "Platform",
        locations: 3,
      }),
    ];
    const { jobs } = port({}, hits);
    const { model, seen } = scripted([
      calls({ name: "search_jobs", input: { queries: ["data engineer"] } }),
      said("ok"),
    ]);
    const result = await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });

    const modelSaw = promptText(seen[1] as LanguageModelV4CallOptions);
    expect(modelSaw).toContain(
      "2 hits, most relevant first:\\n7 | Data Engineer | Acme | Seattle, WA | onsite | USD 150000-180000 per year | 2026-10-02",
    );
    expect(modelSaw).toContain("8 | Data Engineer | Acme | Platform | 3 locations");

    // The browser gets the structured hits, not the text.
    const searched = result.steps
      .flatMap((s) => s.toolResults)
      .find((r) => r.toolName === "search_jobs");
    expect(searched?.output).toEqual({ hits });
  });

  it("tells the model to name places in the person's own words and to use precise titles", async () => {
    const { jobs } = port({});
    const { model, seen } = scripted([said("hi")]);
    await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });
    const system = promptText(seen[0] as LanguageModelV4CallOptions);
    expect(system).toContain("pass their own words in locations");
    expect(system).toContain("Do not list cities or states yourself");
    expect(system).toContain("For a precise profession, use its precise title");
    expect(system).toContain("Never a single generic word");
    expect(system).toContain("Leave company names out of the titles");
    expect(system).toContain("a new, complete search");
  });
  it("publishes only discovered, read jobs with source evidence, in selected order", async () => {
    const hits = [
      hit("1", { title: "Graduate Software Engineer", location: null }),
      hit("2", { title: "Senior Software Engineer" }),
      hit("3"),
      hit("4"),
    ];
    const { jobs } = port(
      {
        "1": "Based in Seattle, Washington. No professional experience required. Python projects welcome.",
        "2": "Requires 5 years of professional software experience.",
        "3": "Python projects welcome.",
        "4": "", // A record without source text cannot establish fit.
      },
      hits,
    );
    const note = (id: string, quote: string) => ({
      id,
      why: "Fits the requested background.",
      evidence: [quote],
    });
    const { model } = scripted([
      calls({ name: "search_jobs", input: { queries: ["software engineer"] } }),
      calls(
        { name: "read_job", input: { id: "1" } },
        { name: "read_job", input: { id: "2" } },
        { name: "read_job", input: { id: "4" } },
      ),
      calls({
        name: "publish_jobs",
        input: {
          jobs: [
            note("3", "Python projects welcome."),
            note("999", "No professional experience required."),
            note("4", "anything"),
            note("2", "Invented requirement"),
            note("1", "No professional experience required."),
            note("1", "Python projects welcome."),
          ],
        },
      }),
      said("One reviewed early-career role in Washington."),
    ]);
    const result = await createJobAgent({
      model,
      jobs,
      profile: "No professional experience; Python projects.",
    }).generate({ prompt: "Early career software in Washington state" });
    const published = result.steps
      .flatMap((step) => step.toolResults)
      .find((tool) => tool.toolName === "publish_jobs");
    expect(published?.output).toMatchObject({
      hits: [hits[0]],
      dropped: 5,
      notes: [{ id: "1", evidence: ["No professional experience required."] }],
    });
  });

  it("does not publish jobs read by id but never discovered, or jobs no longer visible", async () => {
    const { jobs } = port({ "1": "Verified source text.", "2": "Verified source text." });
    jobs.search = async () => [hit("1")];
    jobs.lookup = async () => [hit("2")]; // Job 1 closed; job 2 is visible but was never discovered.
    const { model } = scripted([
      calls({ name: "search_jobs", input: { queries: ["backend engineer"] } }),
      calls({ name: "read_job", input: { id: "1" } }, { name: "read_job", input: { id: "2" } }),
      calls({
        name: "publish_jobs",
        input: {
          jobs: ["1", "2"].map((id) => ({
            id,
            why: "Matches requirements.",
            evidence: ["Verified source text."],
          })),
        },
      }),
      said("No reviewed matches."),
    ]);
    const result = await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });
    expect(
      result.steps.flatMap((s) => s.toolResults).find((t) => t.toolName === "publish_jobs")?.output,
    ).toMatchObject({ hits: [], notes: [], dropped: 2 });
  });

  it("inspects omitted middle passages and pages with one cached source fetch", async () => {
    const middle = "Office: Seattle, Washington. Requires 3 years of professional experience.";
    const body = `${"a".repeat(15_000)}${middle}${"b".repeat(30_000)}`;
    const { jobs, reads } = port({ "1": body });
    const { model, seen } = scripted([
      calls({ name: "search_jobs", input: { queries: ["backend engineer"] } }),
      calls({ name: "read_job", input: { id: "1" } }),
      calls({
        name: "publish_jobs",
        input: { jobs: [{ id: "1", why: "An unsupported claim.", evidence: [middle] }] },
      }),
      calls(
        { name: "read_job", input: { id: "1", terms: ["Seattle", "Requires"] } },
        { name: "read_job", input: { id: "1", start: 14_000 } },
      ),
      calls({
        name: "publish_jobs",
        input: {
          jobs: [
            {
              id: "1",
              why: "Requires three years; suitable for this experienced profile.",
              evidence: [middle],
            },
          ],
        },
      }),
      said("done"),
    ]);
    const result = await createJobAgent({
      model,
      jobs,
      profile: "5 years professional backend experience.",
    }).generate({ prompt: "Seattle backend roles" });
    expect(reads).toEqual(["1"]);
    expect(promptText(seen[2] as LanguageModelV4CallOptions)).not.toContain(middle);
    expect(promptText(seen[4] as LanguageModelV4CallOptions)).toContain(middle);
    const outputs = result.steps
      .flatMap((s) => s.toolResults)
      .filter((t) => t.toolName === "publish_jobs")
      .map((t) => t.output);
    expect(outputs[0]).toMatchObject({ hits: [], dropped: 1 });
    expect(outputs[1]).toMatchObject({ hits: [expect.objectContaining({ id: "1" })], dropped: 0 });
    expect(
      JSON.stringify(
        result.steps.flatMap((s) => s.toolResults).filter((t) => t.toolName === "read_job"),
      ),
    ).not.toContain(middle);
  });

  it("preserves selected ranking and permits a deliberate empty replacement", async () => {
    const { jobs } = port({ "1": "Entry-level role.", "2": "Entry-level role." });
    const { model } = scripted([
      calls({ name: "search_jobs", input: { queries: ["backend engineer"] } }),
      calls({ name: "read_job", input: { id: "1" } }, { name: "read_job", input: { id: "2" } }),
      calls({
        name: "publish_jobs",
        input: {
          jobs: ["2", "1"].map((id) => ({
            id,
            why: "Entry-level role.",
            evidence: ["Entry-level role."],
          })),
        },
      }),
      calls({ name: "publish_jobs", input: { jobs: [] } }),
      said("none"),
    ]);
    const result = await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });
    const outputs = result.steps
      .flatMap((s) => s.toolResults)
      .filter((t) => t.toolName === "publish_jobs")
      .map((t) => t.output);
    expect(outputs[0]).toMatchObject({
      hits: [expect.objectContaining({ id: "2" }), expect.objectContaining({ id: "1" })],
    });
    expect(outputs[1]).toMatchObject({ hits: [], notes: [], dropped: 0 });
  });

  it("instructs the model to distinguish professional experience, preferences and description-only geography", async () => {
    const { jobs } = port({});
    const { model, seen } = scripted([said("hi")]);
    await createJobAgent({ model, jobs, profile: "" }).generate({ prompt: "x" });
    const system = promptText(seen[0] as LanguageModelV4CallOptions);
    for (const rule of [
      "Missing employment history means UNKNOWN",
      "Projects and coursework",
      "Distinguish required from preferred",
      "Seattle in the description",
      "headquarters",
      "Remote does not mean eligible",
      "untrusted DATA",
      "publish_jobs",
      "WITHOUT locations",
    ])
      expect(system).toContain(rule);
  });
  it("rejects publication before the model receives a first read or a new passage", async () => {
    const middle = "Office: Seattle, Washington.";
    const { jobs } = port({ "1": `${"a".repeat(15_000)}${middle}${"b".repeat(30_000)}` });
    const publication = (quote: string) => ({
      name: "publish_jobs",
      input: { jobs: [{ id: "1", why: "Verified geographic match.", evidence: [quote] }] },
    });
    const { model } = scripted([
      calls({ name: "search_jobs", input: { queries: ["backend engineer"] } }),
      calls({ name: "read_job", input: { id: "1", terms: ["Seattle"] } }, publication(middle)),
      calls(publication(middle)),
      said("done"),
    ]);
    const result = await createJobAgent({ model, jobs, profile: "" }).generate({
      prompt: "Seattle roles",
    });
    const published = result.steps
      .flatMap((s) => s.toolResults)
      .filter((t) => t.toolName === "publish_jobs")
      .map((t) => t.output);
    expect(published[0]).toMatchObject({ hits: [], dropped: 1 });
    expect(published[1]).toMatchObject({
      hits: [expect.objectContaining({ id: "1" })],
      dropped: 0,
    });

    const second = scripted([
      calls({ name: "search_jobs", input: { queries: ["backend engineer"] } }),
      calls({ name: "read_job", input: { id: "1" } }),
      calls({ name: "read_job", input: { id: "1", terms: ["Seattle"] } }, publication(middle)),
      calls(publication(middle)),
      said("done"),
    ]);
    const next = await createJobAgent({ model: second.model, jobs, profile: "" }).generate({
      prompt: "Seattle roles",
    });
    const outputs = next.steps
      .flatMap((s) => s.toolResults)
      .filter((t) => t.toolName === "publish_jobs")
      .map((t) => t.output);
    expect(outputs[0]).toMatchObject({ hits: [], dropped: 1 });
    expect(outputs[1]).toMatchObject({ hits: [expect.objectContaining({ id: "1" })], dropped: 0 });
  });
  it("asks to reread previous-turn views rather than claiming the source description is missing", async () => {
    const { jobs } = port({ "1": "Source text still exists." });
    const tools = createTools({ jobs, profile: "", reviewedViews: new Set() });
    const output = await tools.read_job.toModelOutput?.({
      toolCallId: "old",
      input: { id: "1" },
      output: {
        found: true,
        id: "1",
        title: "Engineer",
        company: "Acme",
        chars: 100,
        facts: {},
        view: "previous-turn",
        partial: false,
        notice: undefined,
      },
    });
    expect(output).toMatchObject({
      type: "text",
      value: expect.stringContaining("Call read_job again"),
    });
    expect(JSON.stringify(output)).not.toContain("has no description");
  });
});
