import { emptyResume, type Resume } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { checkResume } from "../src/index.ts";

type Job = Resume["experience"][number];

const job = (overrides: Partial<Job> = {}): Job => ({
  company: "Acme",
  title: "Engineer",
  location: "",
  start: "Jan 2020",
  end: "Present",
  bullets: ["Shipped the billing rewrite", "Cut build time by half"],
  ...overrides,
});

/** A resume with every field a complete resume needs; each test breaks one thing. */
const complete = (): Resume => ({
  ...emptyResume(),
  name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+44 20 7946 0000",
  summary: "Engineer who builds payment systems.",
  experience: [job()],
  skills: [{ label: "Languages", items: ["TypeScript", "Go"] }],
});

const messages = (resume: Resume) => checkResume(resume).map((check) => check.message);

describe("checkResume", () => {
  it("returns nothing for a complete, clean resume", () => {
    expect(checkResume(complete())).toEqual([]);
  });

  it("fixes a missing name", () => {
    expect(messages({ ...complete(), name: " " })).toEqual(["Add your name."]);
  });

  it("fixes a missing email", () => {
    expect(messages({ ...complete(), email: "" })).toEqual(["Add your email address."]);
  });

  it("fixes an email that is not shaped like an address", () => {
    expect(messages({ ...complete(), email: "ada at example" })).toEqual([
      '"ada at example" does not look like an email address.',
    ]);
  });

  it("fixes a missing phone", () => {
    expect(messages({ ...complete(), phone: "" })).toEqual(["Add a phone number."]);
  });

  it("fixes a role with company or title but no start date", () => {
    expect(messages({ ...complete(), experience: [job({ start: "" })] })).toEqual([
      "Add dates to your role at Acme.",
    ]);
  });

  it("names a role by its title when there is no company", () => {
    expect(messages({ ...complete(), experience: [job({ company: "", start: "" })] })).toEqual([
      "Add dates to your role (Engineer).",
    ]);
  });

  it("says when a start date cannot be read", () => {
    expect(messages({ ...complete(), experience: [job({ start: "Spring 2020" })] })).toEqual([
      'Could not read the start date "Spring 2020" for your role at Acme. Use a year or Mon YYYY.',
    ]);
  });

  it("says when an end date cannot be read", () => {
    expect(messages({ ...complete(), experience: [job({ end: "2020-06" })] })).toEqual([
      'Could not read the end date "2020-06" for your role at Acme. Use a year, Mon YYYY or Present.',
    ]);
  });

  it("accepts years, month names, abbreviations and Present or Current", () => {
    const dates = [
      ["2019", "Current"],
      ["march 2019", "Dec 2021"],
      ["Sept 2019", "Jun 2020"],
    ] as const;
    for (const [start, end] of dates) {
      expect(messages({ ...complete(), experience: [job({ start, end })] })).toEqual([]);
    }
  });

  it("rejects years outside 1970-2100 and unknown month words", () => {
    expect(messages({ ...complete(), experience: [job({ start: "1960" })] })).toHaveLength(1);
    expect(messages({ ...complete(), experience: [job({ start: "Smarch 2020" })] })).toHaveLength(
      1,
    );
  });

  it("fixes a role with no bullets", () => {
    expect(messages({ ...complete(), experience: [job({ bullets: [] })] })).toEqual([
      "Add bullets to your role at Acme.",
    ]);
  });

  it("fixes a resume with no experience", () => {
    expect(messages({ ...complete(), experience: [] })).toEqual([
      "Add at least one role to your experience.",
    ]);
  });

  it("tips on a summary longer than 600 characters", () => {
    expect(messages({ ...complete(), summary: "a".repeat(601) })).toEqual([
      "Your summary runs over 600 characters. Keep it to a few sentences.",
    ]);
  });

  it("tips once per role on bullets longer than 240 characters", () => {
    const long = (letter: string) => `${letter}${"x".repeat(240)}`;
    expect(
      messages({
        ...complete(),
        experience: [job({ bullets: [long("A"), long("B"), "Short and fine"] })],
      }),
    ).toEqual(["2 bullets at Acme run long. Aim for two lines."]);
    expect(
      messages({ ...complete(), experience: [job({ bullets: [long("A"), "Fine"] })] }),
    ).toEqual(["1 bullet at Acme runs long. Aim for two lines."]);
  });

  it("tips on bullets that start with a lowercase letter", () => {
    expect(
      messages({ ...complete(), experience: [job({ bullets: ["led a team", "Shipped"] })] }),
    ).toEqual(["1 bullet at Acme starts with a lowercase letter."]);
  });

  it("tips on more than seven bullets in one role", () => {
    const bullets = Array.from({ length: 8 }, (_, i) => `Result number ${i + 1}`);
    expect(messages({ ...complete(), experience: [job({ bullets })] })).toEqual([
      "Your role at Acme has 8 bullets. Keep it to 7 or fewer.",
    ]);
  });

  it("tips on a role with exactly one bullet", () => {
    expect(messages({ ...complete(), experience: [job({ bullets: ["Shipped"] })] })).toEqual([
      "Your role at Acme has only one bullet. Add a second achievement.",
    ]);
  });

  it("tips once when two bullets are identical anywhere in the resume", () => {
    const resume = {
      ...complete(),
      projects: [{ name: "Side project", url: "", bullets: ["Shipped the billing rewrite"] }],
    };
    expect(messages(resume)).toEqual([
      'The bullet "Shipped the billing rewrite" appears more than once.',
    ]);
  });

  it("tips on a resume with no skills listed", () => {
    expect(messages({ ...complete(), skills: [] })).toEqual([
      "List your skills so readers and filters can find them.",
    ]);
  });

  it("tips on more than three links", () => {
    const links = ["a", "b", "c", "d"].map((label) => ({ label, url: `https://${label}.dev` }));
    expect(messages({ ...complete(), links })).toEqual([
      "You list 4 links. Keep the 3 that matter most.",
    ]);
  });

  it("returns fixes before tips, each in resume order", () => {
    const resume: Resume = {
      ...complete(),
      name: "",
      links: ["a", "b", "c", "d"].map((label) => ({ label, url: `https://${label}.dev` })),
      summary: "a".repeat(601),
      experience: [job({ start: "", bullets: ["shipped"] }), job({ company: "Beta", bullets: [] })],
      skills: [],
    };
    const checks = checkResume(resume);
    const levels = checks.map((check) => check.level);
    expect(levels).toEqual([...levels].sort((a, b) => (a === b ? 0 : a === "fix" ? -1 : 1)));
    expect(checks.filter((check) => check.level === "fix").map((check) => check.message)).toEqual([
      "Add your name.",
      "Add dates to your role at Acme.",
      "Add bullets to your role at Beta.",
    ]);
    expect(checks.at(-1)?.message).toBe("List your skills so readers and filters can find them.");
  });
});
