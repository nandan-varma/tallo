import { describe, expect, it } from "vitest";
import { workModeOf } from "../src/kit.ts";

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
