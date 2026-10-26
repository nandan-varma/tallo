import { describe, expect, it } from "vitest";
import { paragraphs, wordCount } from "@/lib/resume/letter-text";

describe("letter text", () => {
  it("splits on blank lines and keeps single line breaks inside a paragraph", () => {
    const letter =
      "Dear Hiring Team,\n\nFirst paragraph.\nStill first.\n\n\nSincerely,\nJane Roe\n";
    expect(paragraphs(letter)).toEqual([
      "Dear Hiring Team,",
      "First paragraph.\nStill first.",
      "Sincerely,\nJane Roe",
    ]);
  });

  it("drops empty paragraphs and handles windows line endings", () => {
    expect(paragraphs("  \r\n\r\nOne.\r\n\r\n   \r\n\r\nTwo.  ")).toEqual(["One.", "Two."]);
    expect(paragraphs("")).toEqual([]);
  });

  it("counts words", () => {
    expect(wordCount("  one two\nthree ")).toBe(3);
    expect(wordCount("   ")).toBe(0);
  });
});
