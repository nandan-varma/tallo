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
    // A value that states a mode plus other words keeps the stated mode (Jobvite, Greenhouse).
    ["Hybrid Remote", "hybrid"],
    ["Hybrid (Travel-Required)", "hybrid"],
    // Precedence when a source states more than one: hybrid > remote > onsite.
    ["Remote or On-Site", "remote"],
    ["Hybrid / On-Site", "hybrid"],
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
  ])("leaves a value that names no mode (%s) undefined", (value, expected) => {
    expect(workModeOf(value)).toBe(expected);
  });
});
