import { emptyResume } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { blank, move, removeAt, replaceAt, splitItems, tidy } from "@/lib/resume/edit";

describe("list edits", () => {
  it("moves, removes and replaces without touching the original", () => {
    const list = ["a", "b", "c"];
    expect(move(list, 0, 2)).toEqual(["b", "c", "a"]);
    expect(move(list, 2, 1)).toEqual(["a", "c", "b"]);
    expect(move(list, 0, 3)).toEqual(list);
    expect(removeAt(list, 1)).toEqual(["a", "c"]);
    expect(replaceAt(list, 1, "x")).toEqual(["a", "x", "c"]);
    expect(list).toEqual(["a", "b", "c"]);
  });
});

describe("tidy", () => {
  it("drops blank bullets, empty entries and links without an address", () => {
    const resume = {
      ...emptyResume(),
      links: [
        { label: "Site", url: " " },
        { label: "", url: "ada.dev" },
      ],
      experience: [
        { ...blank.experience(), company: "Acme", bullets: ["Built it.", "  ", ""] },
        blank.experience(),
      ],
      skills: [
        { label: "Empty", items: [] },
        { label: "Langs", items: ["Go", " "] },
      ],
      extras: [{ title: "Awards", items: [""] }],
    };
    const out = tidy(resume);
    expect(out.links).toEqual([{ label: "", url: "ada.dev" }]);
    expect(out.experience).toHaveLength(1);
    expect(out.experience[0]?.bullets).toEqual(["Built it."]);
    expect(out.skills).toEqual([{ label: "Langs", items: ["Go"] }]);
    expect(out.extras).toEqual([]);
  });
});

describe("splitItems", () => {
  it("splits on commas and trims", () => {
    expect(splitItems(" Go,  TypeScript ,, SQL ")).toEqual(["Go", "TypeScript", "SQL"]);
  });
});
