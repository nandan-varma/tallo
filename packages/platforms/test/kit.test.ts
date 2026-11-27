import type { CollectContext, Issue, RawPosting } from "@tallo/contracts";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import {
  captureGroups,
  jobPostingLd,
  jsonScripts,
  parseJsonLoosely,
  uniqueWithinBudget,
  workModeOf,
} from "../src/kit.ts";

describe("workModeOf", () => {
  it.each([
    ["Remote", "remote"],
    ["remote", "remote"],
    ["Hybrid", "hybrid"],
    ["On-Site", "onsite"],
    ["Onsite", "onsite"],
    ["ON_SITE", "onsite"],
    ["On Site", "onsite"],
    ["In Office", "onsite"],
    ["In-Person", "onsite"],
    // One mode stated with other words: the mode is kept (Greenhouse "Hybrid (Travel-Required)").
    ["Hybrid (Travel-Required)", "hybrid"],
  ] as const)("reads the mode words in %s as %s", (value, expected) => {
    expect(workModeOf(value)).toBe(expected);
  });

  it.each([
    ["", undefined],
    ["   ", undefined],
    [undefined, undefined],
    [null, undefined],
    ["Flexible", undefined],
    ["Office", undefined],
    ["Online", undefined],
    ["Unspecified", undefined],
    // More than one mode stated: the source does not state one mode, so nothing is read.
    ["Remote or On-Site", undefined],
    ["Onsite or remote", undefined],
    ["Hybrid / On-Site", undefined],
    // "Hybrid Remote" (Jobvite's shape) states two modes; it is not a single stated hybrid token.
    ["Hybrid Remote", undefined],
    // Negation: the source says the mode does not apply.
    ["Non-Remote", undefined],
    ["Not remote", undefined],
    ["Not Hybrid", undefined],
    ["Not on-site", undefined],
    ["No remote", undefined],
  ])("leaves a value that does not state exactly one mode (%s) undefined", (value, expected) => {
    expect(workModeOf(value)).toBe(expected);
  });
});

describe("jsonScripts and jobPostingLd", () => {
  const page = (...scripts: string[]) =>
    parse(`<html><head>${scripts.join("")}</head><body></body></html>`);
  const ld = (body: string) => `<script type="application/ld+json">${body}</script>`;

  it("parses JSON that holds entities inside its strings, as the page wrote them", () => {
    // A job description with quotes arrives as &quot; in the script body; decoding it first would break the JSON.
    const root = page(
      ld(
        '{"@type":"JobPosting","title":"Nurse","description":"Care for &quot;patients&quot; &amp; families"}',
      ),
    );
    expect(jobPostingLd(root)).toEqual({
      "@type": "JobPosting",
      title: "Nurse",
      description: "Care for &quot;patients&quot; &amp; families",
    });
  });

  it("skips scripts that are not JSON and other schema types", () => {
    const root = page(
      ld("not json"),
      ld('{"@type":"Organization","name":"Acme"}'),
      ld('{"@type":"JobPosting","title":"Analyst"}'),
    );
    expect(jobPostingLd(root)).toEqual({ "@type": "JobPosting", title: "Analyst" });
    expect(jsonScripts(root, 'script[type="application/ld+json"]')).toHaveLength(2);
  });

  it("is undefined when the page publishes no JobPosting", () => {
    expect(jobPostingLd(page(ld('{"@type":"Organization"}')))).toBeUndefined();
    expect(jobPostingLd(page())).toBeUndefined();
  });

  it("reads other selectors too", () => {
    const root = page('<script type="application/json">{"a":1}</script>');
    expect(jsonScripts(root, 'script[type="application/json"]')).toEqual([{ a: 1 }]);
  });
});

describe("parseJsonLoosely", () => {
  it("parses valid JSON as JSON.parse does", () => {
    expect(parseJsonLoosely('{"a":[1,"x\\ny"]}')).toEqual({ a: [1, "x\ny"] });
  });

  it("accepts a raw tab or newline inside a string and keeps the character", () => {
    expect(parseJsonLoosely('{"d":"one\ttwo\nthree"}')).toEqual({ d: "one\ttwo\nthree" });
  });

  it("leaves whitespace between tokens and escaped quotes alone", () => {
    expect(parseJsonLoosely('{\n\t"a": "say \\"hi\\"\tnow",\n\t"b": 2\n}')).toEqual({
      a: 'say "hi"\tnow',
      b: 2,
    });
  });

  it("is undefined when the text is not JSON at all", () => {
    expect(parseJsonLoosely("not json")).toBeUndefined();
    expect(parseJsonLoosely('{"a":')).toBeUndefined();
  });
});

describe("captureGroups", () => {
  it("yields the capture groups of each match, empty for a group that did not take part", () => {
    const pattern = /<a id="(\d+)"(?: v="(\w+)")?>/g;
    expect([...captureGroups(pattern, '<a id="1" v="x"><a id="2">')]).toEqual([
      ["1", "x"],
      ["2", ""],
    ]);
  });

  it("yields nothing when there is no match", () => {
    expect([...captureGroups(/(\d+)/g, "none")]).toEqual([]);
  });
});

describe("uniqueWithinBudget", () => {
  const posting = (id: string): RawPosting => ({ id, listing: { id } });
  const context = (maxPostings: number) => {
    const issues: Issue[] = [];
    return {
      ctx: {
        maxPostings,
        record: (issue: Issue) => void issues.push(issue),
      } as unknown as CollectContext,
      issues,
    };
  };
  /** Runs the generator to its end and returns what it yielded and what it returned. */
  async function run(gen: AsyncGenerator<RawPosting, { complete: boolean; listed: number }>) {
    const ids: string[] = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) return { ids, ...next.value };
      ids.push(next.value.id);
    }
  }

  it("passes each posting on once, in order, and reports a complete listing", async () => {
    const { ctx, issues } = context(100);
    const result = await run(uniqueWithinBudget([posting("a"), posting("b"), posting("a")], ctx));
    expect(result).toEqual({ ids: ["a", "b"], complete: true, listed: 2 });
    expect(issues).toEqual([]);
  });

  it("stops at the budget with an incomplete listing and a budget issue", async () => {
    const { ctx, issues } = context(2);
    const result = await run(uniqueWithinBudget([posting("a"), posting("b"), posting("c")], ctx));
    expect(result).toEqual({ ids: ["a", "b"], complete: false, listed: 2 });
    expect(issues).toEqual([{ code: "budget", message: "Stopped at 2 postings" }]);
  });

  it("counts only distinct postings against the budget", async () => {
    const { ctx } = context(2);
    const result = await run(uniqueWithinBudget([posting("a"), posting("a"), posting("b")], ctx));
    expect(result).toMatchObject({ ids: ["a", "b"], complete: false });
  });

  it("reads an async source too, one item at a time", async () => {
    async function* source(): AsyncGenerator<RawPosting> {
      yield posting("x");
      yield posting("y");
    }
    const { ctx } = context(100);
    expect(await run(uniqueWithinBudget(source(), ctx))).toEqual({
      ids: ["x", "y"],
      complete: true,
      listed: 2,
    });
  });

  it("is complete with nothing listed for an empty source", async () => {
    const { ctx } = context(100);
    expect(await run(uniqueWithinBudget([], ctx))).toEqual({ ids: [], complete: true, listed: 0 });
  });
});
