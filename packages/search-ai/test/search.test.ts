import { describe, expect, it } from "vitest";
import { search } from "../src/search.ts";
import type { Verdict } from "../src/types.ts";
import {
  type Call,
  candidate,
  fakeJobs,
  fakeModel,
  JUDGE_REPLY,
  PROFILE,
  postingIds,
  type Truncated,
  UNDERSTAND_REPLY,
} from "./fakes.ts";

// Stage-aware responder. `verdicts` drives triage; `judge` builds the judgment reply per job.
function responder(opts: {
  verdicts?: Record<string, Verdict>;
  judge?: (call: Call) => string;
  notes?: string;
}) {
  return (call: Call): string => {
    switch (call.stage) {
      case "understand":
        return UNDERSTAND_REPLY;
      case "triage":
        return JSON.stringify({
          decisions: postingIds(call.text).map((id) => ({
            id,
            verdict: opts.verdicts?.[id] ?? "maybe",
            reason: `reason for ${id}`,
          })),
        });
      case "notes":
        return JSON.stringify({ notes: opts.notes ?? "notes" });
      case "judge":
        return opts.judge ? opts.judge(call) : JUDGE_REPLY();
      default:
        throw new Error(`unexpected stage ${call.stage}`);
    }
  };
}

function setup(respond: (call: Call) => string | Truncated | Promise<string | Truncated>) {
  const calls: Call[] = [];
  const models = { fast: fakeModel(calls, respond), smart: fakeModel(calls, respond) };
  return { calls, models };
}

const stagesOf = (calls: Call[]) => calls.map((c) => c.stage);

describe("search", () => {
  it("returns an empty answer when recall finds nothing", async () => {
    const { calls, models } = setup(responder({}));
    const jobs = fakeJobs({ candidates: [] });

    const result = await search({ query: "rust", profile: PROFILE, models, jobs });

    expect(result.answer.items).toEqual([]);
    expect(result.trace.recall.candidates).toBe(0);
    expect(stagesOf(calls)).toEqual(["understand"]);
    expect(jobs.descriptionCalls).toEqual([]);
  });

  it("never reads descriptions for obvious rejects", async () => {
    const candidates = [candidate("a"), candidate("b"), candidate("c")];
    const { calls, models } = setup(responder({ verdicts: { a: "no", b: "no", c: "no" } }));
    const jobs = fakeJobs({ candidates, descriptions: { a: "x", b: "y", c: "z" } });

    const result = await search({ query: "backend", profile: PROFILE, models, jobs });

    expect(result.answer.items).toEqual([]);
    expect(jobs.descriptionCalls).toEqual([]);
    expect(calls.some((c) => c.stage === "judge" || c.stage === "notes")).toBe(false);
    expect(result.trace.triage.no).toBe(3);
  });

  it("caps deep reads at deepReads and reads maybes in recall order", async () => {
    const candidates = Array.from({ length: 30 }, (_, i) => candidate(`j${i}`));
    const { calls, models } = setup(responder({}));
    const jobs = fakeJobs({
      candidates,
      descriptions: Object.fromEntries(candidates.map((c) => [c.id, `Description of ${c.id}.`])),
    });

    const result = await search({
      query: "backend",
      profile: PROFILE,
      models,
      jobs,
      options: { deepReads: 3, answerLimit: 10 },
    });

    expect(jobs.descriptionCalls).toEqual(["j0", "j1", "j2"]);
    expect(calls.filter((c) => c.stage === "judge")).toHaveLength(3);
    expect(result.trace.deep.reads).toBe(3);
    expect(result.answer.items).toHaveLength(3);
  });

  it("passes the full description to the model unmodified", async () => {
    const filler = "We build reliable backend services in TypeScript. ".repeat(100);
    const description = `${filler}\nCompensation: $150,000 - $180,000 base. Minimum: 5 years of backend work.`;
    expect(description.length).toBeGreaterThan(5000);
    const { calls, models } = setup(responder({}));
    const jobs = fakeJobs({ candidates: [candidate("a")], descriptions: { a: description } });

    const result = await search({ query: "backend", profile: PROFILE, models, jobs });

    const judge = calls.find((c) => c.stage === "judge");
    expect(judge).toBeDefined();
    const block = /<description>\n([\s\S]*?)\n<\/description>/.exec(judge?.text ?? "")?.[1];
    expect(block).toBe(description);
    expect(block?.length).toBe(description.length);
    expect(block?.endsWith("5 years of backend work.")).toBe(true);
    expect(result.trace.deep.descriptionChars).toBe(description.length);
    expect(result.trace.deep.chunks).toBe(1);
    expect(calls.some((c) => c.stage === "notes")).toBe(false);
  });

  it("reads an oversized description in consecutive parts and carries notes forward", async () => {
    const description = Array.from(
      { length: 40 },
      (_, i) => `Line ${i}: requirement text ${"x".repeat(20)}`,
    ).join("\n");
    expect(description.length).toBeGreaterThan(1000);
    const { calls, models } = setup(responder({ notes: "pay 150k seen" }));
    const jobs = fakeJobs({ candidates: [candidate("a")], descriptions: { a: description } });

    const result = await search({
      query: "backend",
      profile: PROFILE,
      models,
      jobs,
      options: { descriptionChunkChars: 400 },
    });

    const notes = calls.filter((c) => c.stage === "notes");
    const parts = notes.map(
      (c) => /<part index="\d+" of="\d+">\n([\s\S]*?)\n<\/part>/.exec(c.text)?.[1] ?? "",
    );
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 400)).toBe(true);
    expect(parts.join("")).toBe(description);
    expect(notes.every((c) => c.text.includes(`of="${parts.length}"`))).toBe(true);
    // Second and later parts see the notes produced so far.
    expect(notes[1]?.text).toContain("<notes_so_far>pay 150k seen</notes_so_far>");
    expect(result.trace.deep.chunks).toBe(parts.length);
    expect(result.trace.deep.descriptionChars).toBe(description.length);
    const judge = calls.find((c) => c.stage === "judge");
    expect(judge?.text).toContain(`read in ${parts.length} consecutive parts`);
  });

  it("passes a 20k description to the judge whole, end marker included", async () => {
    const marker = "END-MARKER-20K";
    const line = "Build reliable backend services in TypeScript on AWS, with on-call habits. ";
    const description = `${line.repeat(Math.ceil(20_000 / line.length)).slice(0, 20_000 - marker.length)}${marker}`;
    expect(description.length).toBe(20_000);
    const { calls, models } = setup(responder({}));
    const jobs = fakeJobs({ candidates: [candidate("a")], descriptions: { a: description } });

    const result = await search({ query: "backend", profile: PROFILE, models, jobs });

    const judge = calls.find((c) => c.stage === "judge");
    const block = /<description>\n([\s\S]*?)\n<\/description>/.exec(judge?.text ?? "")?.[1];
    expect(block?.length).toBe(20_000);
    expect(block).toBe(description);
    expect(block?.endsWith(marker)).toBe(true);
    expect(result.trace.deep.descriptionChars).toBe(20_000);
    expect(result.trace.deep.chunks).toBe(1);
    expect(calls.some((c) => c.stage === "notes")).toBe(false);
  });

  it("reads a 60k description in every part at the default chunk size and loses nothing", async () => {
    const marker = "END-MARKER-60K";
    const rows: string[] = [];
    let length = 0;
    for (let i = 0; length < 60_000; i++) {
      const row = `Line ${i}: we ship backend services in TypeScript and Postgres, on call weekly.`;
      rows.push(row);
      length += row.length + 1;
    }
    const description = `${rows.join("\n")}\n${marker}`;
    expect(description.length).toBeGreaterThan(60_000);
    const { calls, models } = setup(responder({ notes: "notes so far" }));
    const jobs = fakeJobs({ candidates: [candidate("a")], descriptions: { a: description } });

    const result = await search({ query: "backend", profile: PROFILE, models, jobs });

    const notes = calls.filter((c) => c.stage === "notes");
    const parts = notes.map(
      (c) => /<part index="\d+" of="\d+">\n([\s\S]*?)\n<\/part>/.exec(c.text)?.[1] ?? "",
    );
    expect(parts.length).toBe(3);
    expect(parts.join("")).toBe(description);
    expect(parts.at(-1)?.endsWith(marker)).toBe(true);
    expect(notes.every((c) => c.text.includes(`of="3"`))).toBe(true);
    expect(result.trace.deep.chunks).toBe(3);
    expect(result.trace.deep.descriptionChars).toBe(description.length);
    const judge = calls.find((c) => c.stage === "judge");
    expect(judge?.text).toContain("read in 3 consecutive parts");
  });

  it("stops with a loud error instead of making a model call past maxModelCalls", async () => {
    // understand (1), triage (2), judge (3): a ceiling of 2 must stop before the judge call.
    const { calls, models } = setup(responder({}));
    const jobs = fakeJobs({ candidates: [candidate("a")], descriptions: { a: "short" } });

    await expect(
      search({ query: "backend", profile: PROFILE, models, jobs, options: { maxModelCalls: 2 } }),
    ).rejects.toThrow(/maxModelCalls/);
    expect(stagesOf(calls)).toEqual(["understand", "triage"]);
  });

  it("completes when the ceiling exactly covers the calls it needs", async () => {
    const { calls, models } = setup(responder({}));
    const jobs = fakeJobs({ candidates: [candidate("a")], descriptions: { a: "short" } });

    await search({
      query: "backend",
      profile: PROFILE,
      models,
      jobs,
      options: { maxModelCalls: 3 },
    });
    expect(stagesOf(calls)).toEqual(["understand", "triage", "judge"]);
  });

  it("throws instead of truncating when a description needs more than maxDescriptionParts", async () => {
    const description = "x ".repeat(500); // 1000 chars: 10 parts of 100
    const { calls, models } = setup(responder({}));
    const jobs = fakeJobs({ candidates: [candidate("a")], descriptions: { a: description } });

    await expect(
      search({
        query: "backend",
        profile: PROFILE,
        models,
        jobs,
        options: { descriptionChunkChars: 100, maxDescriptionParts: 9 },
      }),
    ).rejects.toThrow(/maxDescriptionParts/);
    expect(calls.some((c) => c.stage === "notes" || c.stage === "judge")).toBe(false);
  });

  it("reads a description that needs exactly maxDescriptionParts parts", async () => {
    const description = "x ".repeat(500);
    const { calls, models } = setup(responder({ notes: "n" }));
    const jobs = fakeJobs({ candidates: [candidate("a")], descriptions: { a: description } });

    const result = await search({
      query: "backend",
      profile: PROFILE,
      models,
      jobs,
      options: { descriptionChunkChars: 100, maxDescriptionParts: 10 },
    });

    expect(calls.filter((c) => c.stage === "notes")).toHaveLength(10);
    expect(result.trace.deep.chunks).toBe(10);
  });

  it("retries once with a larger budget when content is empty", async () => {
    let first = true;
    const calls: Call[] = [];
    const respond = (call: Call) => {
      if (call.stage === "understand" && first) {
        first = false;
        return "";
      }
      return responder({})(call);
    };
    const models = { fast: fakeModel(calls, respond), smart: fakeModel(calls, respond) };
    const jobs = fakeJobs({ candidates: [] });

    const result = await search({ query: "backend", profile: PROFILE, models, jobs });

    const understand = calls.filter((c) => c.stage === "understand");
    expect(understand).toHaveLength(2);
    expect(understand[1]?.maxOutputTokens).toBe((understand[0]?.maxOutputTokens ?? 0) * 2);
    expect(result.trace.retries).toBe(1);
    // The empty attempt was still billed: both attempts (5 in, 7 out each) are in the trace.
    expect(result.trace.tokens.fast).toEqual({ input: 10, output: 14 });
  });

  it("counts a retry toward maxModelCalls", async () => {
    // understand is empty (call 1), its retry answers (call 2). Triage would be call 3: a ceiling of 2
    // must stop before it. A retry that is not counted would let triage through.
    let first = true;
    const respond = (call: Call) => {
      if (call.stage === "understand" && first) {
        first = false;
        return "";
      }
      return responder({})(call);
    };
    const { calls, models } = setup(respond);
    const jobs = fakeJobs({ candidates: [candidate("a")], descriptions: { a: "short" } });

    await expect(
      search({ query: "backend", profile: PROFILE, models, jobs, options: { maxModelCalls: 2 } }),
    ).rejects.toThrow(/maxModelCalls/);
    expect(stagesOf(calls)).toEqual(["understand", "understand"]);
  });

  it("retries with a doubled budget when the JSON is cut off at maxOutputTokens", async () => {
    let first = true;
    const respond = (call: Call) => {
      if (call.stage === "triage" && first) {
        first = false;
        return { truncated: '{"decisions":[{"id":"a","verdict":"str' };
      }
      return responder({ verdicts: { a: "strong" } })(call);
    };
    const { calls, models } = setup(respond);
    const jobs = fakeJobs({ candidates: [candidate("a")] });

    const result = await search({ query: "backend", profile: PROFILE, models, jobs });

    const triage = calls.filter((c) => c.stage === "triage");
    expect(triage).toHaveLength(2);
    expect(triage[1]?.maxOutputTokens).toBe((triage[0]?.maxOutputTokens ?? 0) * 2);
    expect(result.trace.triage.strong).toBe(1);
  });

  it("fails when content is still empty after the retry", async () => {
    const { models } = setup(() => "");
    const jobs = fakeJobs({ candidates: [candidate("a")] });

    await expect(search({ query: "backend", profile: PROFILE, models, jobs })).rejects.toThrow();
  });

  it("sets an explicit output budget on every model call", async () => {
    const { calls, models } = setup(responder({ verdicts: { a: "strong" } }));
    const jobs = fakeJobs({
      candidates: [candidate("a"), candidate("b")],
      descriptions: { b: "Pay: $100k" },
    });

    await search({ query: "backend", profile: PROFILE, models, jobs });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => Number.isInteger(c.maxOutputTokens) && c.maxOutputTokens > 0)).toBe(
      true,
    );
  });

  it("answers strong rows without a deep read and keeps them ahead of maybes", async () => {
    const candidates = [candidate("s1"), candidate("m1"), candidate("s2")];
    const { models } = setup(responder({ verdicts: { s1: "strong", s2: "strong" } }));
    const jobs = fakeJobs({ candidates, descriptions: { m1: "Pay: $90k" } });

    const result = await search({ query: "backend", profile: PROFILE, models, jobs });

    expect(jobs.descriptionCalls).toEqual(["m1"]);
    expect(result.answer.items.map((i) => [i.id, i.verdict, i.rank])).toEqual([
      ["s1", "strong", 1],
      ["s2", "strong", 2],
      ["m1", "maybe", 3],
    ]);
    expect(result.answer.items[0]?.fit).toBeNull();
  });

  it("orders deep-read maybes by fit and reports missing facts as unknowns", async () => {
    const candidates = [candidate("low"), candidate("high", { pay: null, workMode: null })];
    const { models } = setup(
      responder({
        judge: (call) =>
          call.text.includes("Engineer low") ? JUDGE_REPLY({ fit: 40 }) : JUDGE_REPLY({ fit: 85 }),
      }),
    );
    const jobs = fakeJobs({
      candidates,
      descriptions: { low: "Pay: $100k", high: "Requirements: Go." },
    });

    const result = await search({ query: "backend", profile: PROFILE, models, jobs });

    expect(result.answer.items.map((i) => [i.id, i.fit])).toEqual([
      ["high", 85],
      ["low", 40],
    ]);
    const high = result.answer.items[0];
    expect(high?.unknowns).toEqual(
      expect.arrayContaining(["pay not listed", "work mode not listed"]),
    );
  });

  it("keeps only evidence quotes that appear verbatim in the description or profile", async () => {
    const { models } = setup(
      responder({
        judge: () =>
          JSON.stringify({
            fit: 80,
            reason: "Pay is stated",
            evidence: ["Pay: $150k base", "invented quote that is not in the text"],
            unknowns: [],
          }),
      }),
    );
    const jobs = fakeJobs({
      candidates: [candidate("a")],
      descriptions: { a: "Pay: $150k base. Remote." },
    });

    const result = await search({ query: "backend", profile: PROFILE, models, jobs });

    expect(result.answer.items[0]?.evidence).toEqual(["Pay: $150k base"]);
    expect(result.trace.deep.droppedEvidence).toBe(1);
  });

  it("treats triage decisions it did not return as maybe", async () => {
    const candidates = [candidate("a"), candidate("b")];
    const calls: Call[] = [];
    const respond = (call: Call) => {
      if (call.stage === "triage") {
        return JSON.stringify({ decisions: [{ id: "a", verdict: "strong", reason: "fits" }] });
      }
      return responder({})(call);
    };
    const models = { fast: fakeModel(calls, respond), smart: fakeModel(calls, respond) };
    const jobs = fakeJobs({ candidates, descriptions: { b: "text" } });

    const result = await search({ query: "backend", profile: PROFILE, models, jobs });

    expect(result.trace.triage.defaulted).toBe(1);
    expect(result.trace.triage.decisions).toEqual([
      { id: "a", verdict: "strong" },
      { id: "b", verdict: "maybe" },
    ]);
    expect(jobs.descriptionCalls).toEqual(["b"]);
  });

  it("splits triage into batches of triageBatchSize", async () => {
    const candidates = Array.from({ length: 7 }, (_, i) => candidate(`t${i}`));
    const { calls, models } = setup(
      responder({ verdicts: Object.fromEntries(candidates.map((c) => [c.id, "no"])) }),
    );
    const jobs = fakeJobs({ candidates });

    const result = await search({
      query: "backend",
      profile: PROFILE,
      models,
      jobs,
      options: { triageBatchSize: 3 },
    });

    expect(calls.filter((c) => c.stage === "triage")).toHaveLength(3);
    expect(result.trace.triage.batches).toBe(3);
    expect(result.trace.triage.no).toBe(7);
  });

  it("rejects non-integer options", async () => {
    const { models } = setup(responder({}));
    const jobs = fakeJobs({ candidates: [] });

    await expect(
      search({ query: "x", profile: PROFILE, models, jobs, options: { deepReads: 1.5 } }),
    ).rejects.toThrow(RangeError);
  });
});
