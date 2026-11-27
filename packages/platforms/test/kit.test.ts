import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { jobPostingLd, jsonScripts, parseJsonLoosely, workModeOf } from "../src/kit.ts";

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
