import { describe, expect, it } from "vitest";
import { retirableSourceIds } from "../src/sources.ts";

describe("retire command guard", () => {
  it("refuses a board that is still in the reviewed sources/ files", () => {
    expect(() => retirableSourceIds(["greenhouse:live"], ["greenhouse:live"])).toThrow(
      /Remove confirmed retired boards from sources\/ first: greenhouse:live/,
    );
  });

  it("deduplicates ids, keeps their order, and applies the API's bound", () => {
    expect(
      retirableSourceIds(["greenhouse:old", "lever:old", "greenhouse:old"], ["lever:live"]),
    ).toEqual(["greenhouse:old", "lever:old"]);
    const ids = Array.from({ length: 11 }, (_, i) => `greenhouse:s${i}`);
    expect(() => retirableSourceIds(ids, [])).toThrow(/at most 10/);
  });
});
