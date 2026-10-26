import { describe, expect, it } from "vitest";
import { chunkText } from "../src/chunk.ts";

// A lone UTF-16 surrogate: a high half not followed by a low half, or a low half not preceded by a high half.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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

  it("never separates a surrogate pair on a hard cut", () => {
    // The hard cut at 10 would land between the two halves of the emoji at indexes 9 and 10.
    const text = `${"x".repeat(9)}😀y`;
    expect(chunkText(text, 10)).toEqual(["x".repeat(9), "😀y"]);

    const emoji = "a😀b😀c";
    const parts = chunkText(emoji, 2);
    expect(parts).toEqual(["a", "😀", "b", "😀", "c"]);
    expect(parts.join("")).toBe(emoji);
  });

  it("produces no lone surrogate for any limit", () => {
    const text = `${"😀é".repeat(200)} tail`;
    for (let limit = 2; limit <= 12; limit++) {
      const parts = chunkText(text, limit);
      expect(parts.join("")).toBe(text);
      expect(parts.every((p) => p.length > 0 && p.length <= limit)).toBe(true);
      expect(parts.some((p) => LONE_SURROGATE.test(p))).toBe(false);
    }
  });

  it("returns the text as one part when it fits, and nothing for empty text", () => {
    expect(chunkText("short", 100)).toEqual(["short"]);
    expect(chunkText("", 100)).toEqual([]);
  });

  it("rejects a limit too small to hold a surrogate pair", () => {
    expect(() => chunkText("abc", 0)).toThrow(RangeError);
    expect(() => chunkText("abc", 1)).toThrow(RangeError);
  });
});
