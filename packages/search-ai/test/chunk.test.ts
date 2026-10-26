import { describe, expect, it } from "vitest";
import { chunkText } from "../src/chunk.ts";

describe("chunkText", () => {
  it("keeps every character and every part within the limit", () => {
    const text = `${"word ".repeat(500)}\n${"x".repeat(333)}`;
    const parts = chunkText(text, 120);

    expect(parts.join("")).toBe(text);
    expect(parts.every((p) => p.length > 0 && p.length <= 120)).toBe(true);
    expect(parts.length).toBeGreaterThan(1);
  });

  it("prefers a newline, then a space, before a hard cut", () => {
    expect(chunkText("aaaa\nbbbb cccc", 10)).toEqual(["aaaa\n", "bbbb cccc"]);
    expect(chunkText("aaaa bbbbbbbbbbbbbb", 10)).toEqual(["aaaa ", "bbbbbbbbbb", "bbbb"]);
  });

  it("returns the text as one part when it fits, and nothing for empty text", () => {
    expect(chunkText("short", 100)).toEqual(["short"]);
    expect(chunkText("", 100)).toEqual([]);
  });

  it("rejects a non-positive limit", () => {
    expect(() => chunkText("abc", 0)).toThrow(RangeError);
  });
});
