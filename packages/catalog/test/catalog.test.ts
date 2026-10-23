import { describe, expect, it } from "vitest";
import {
  annualizeBase,
  classify,
  extractCompensation,
  extractExperience,
  gunzip,
  htmlToText,
  parseLocation,
  prepareJob,
  summarizeExperience,
  usFlag,
} from "../src/index.ts";

describe("htmlToText", () => {
  it("handles escaped Greenhouse HTML, lists and entities", () => {
    const text = htmlToText(
      "&lt;p&gt;Hi &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;li&gt;Two&lt;/li&gt;&lt;/ul&gt;",
    );
    expect(text).toContain("Hi & welcome");
    expect(text).toMatch(/- One\n- Two/);
    expect(text).not.toContain("<");
  });
  it("drops scripts and link targets", () => {
    expect(
      htmlToText('<p>See <a href="https://x.test">the docs</a></p><script>alert(1)</script>'),
    ).toBe("See the docs");
  });
});

describe("parseLocation / usFlag", () => {
  it.each([
    ["Austin, TX", "US"],
    ["San Francisco, California", "US"],
    ["Remote - USA", "US"],
    ["Tokyo, Japan", "JP"],
    ["Toronto, ON", "CA"],
    ["Vancouver, Canada", "CA"],
    ["London, United Kingdom", "GB"],
  ])("%s -> %s", (text, code) => expect(parseLocation(text).countryCode).toBe(code));
  it("leaves bare remote unknown, flags it remote", () => {
    const l = parseLocation("Remote");
    expect(l.countryCode).toBeUndefined();
    expect(l.remote).toBe(true);
    expect(usFlag([l])).toBeNull();
  });
  it("usFlag is 0 only when every location is known and non-US", () => {
    expect(usFlag([parseLocation("Berlin, Germany"), parseLocation("Paris, France")])).toBe(0);
    expect(usFlag([parseLocation("Berlin, Germany"), parseLocation("Austin, TX")])).toBe(1);
    expect(usFlag([parseLocation("Berlin, Germany"), parseLocation("Remote")])).toBeNull();
  });
});

describe("extractors", () => {
  it("keeps min-only experience as min-only", () => {
    const [q] = extractExperience("You have 5+ years of experience building services.");
    expect(q).toMatchObject({ min: 5, kind: "required", inferred: true });
    expect(q?.max).toBeUndefined();
  });
  it("reads ranges and preferred", () => {
    const qs = extractExperience("3-5 years of Go. Nice to have: 2+ years of Rust.");
    expect(qs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ min: 3, max: 5, kind: "required" }),
        expect.objectContaining({ min: 2, kind: "preferred" }),
      ]),
    );
    expect(summarizeExperience(qs)).toEqual({ min: 3, max: 5 });
  });
  it("extracts salary bands and annualizes", () => {
    const [m] = extractCompensation("The range is $120,000 - $150,000 per year plus equity.");
    expect(m).toMatchObject({ min: 120000, max: 150000, currency: "USD", interval: "year" });
    expect(
      annualizeBase([{ min: 50, max: 60, interval: "hour", component: "base", currency: "USD" }]),
    ).toEqual({ min: 104000, max: 124800, currency: "USD" });
  });
  it("handles k-suffix and ignores unrelated dollars", () => {
    expect(extractCompensation("$120-150k a year")[0]).toMatchObject({ min: 120000, max: 150000 });
    expect(extractCompensation("We raised $50 million last year")).toEqual([]);
  });
});

describe("classify", () => {
  const us = [parseLocation("Austin, TX")];
  it.each([
    ["Senior Software Engineer", undefined, 1],
    ["Product Manager", undefined, 1],
    ["Registered Nurse", undefined, 0],
    ["Account Executive", "Sales", 0],
    ["Engineer II", "Engineering", 1],
    ["Office Coordinator", undefined, null],
    ["Mechanical Engineer", "Engineering", 0],
  ])("%s (%s) -> %s", (title, department, expected) => {
    expect(classify({ title, department, locations: us }).isTech).toBe(expected);
  });
});

describe("prepareJob", () => {
  const source = { id: "x:y", platform: "x", key: "y", company: "Y", params: {} };
  const job = {
    postingId: "1",
    title: "Software Engineer",
    description: "Build things. 3+ years of experience. $100,000 - $120,000 per year.",
    locations: [parseLocation("Austin, TX")],
    compensation: [],
    experience: [],
    extras: {},
  };
  it("derives facts and round-trips the JD", async () => {
    const hash = "a".repeat(64);
    const a = await prepareJob(job, source, hash);
    expect(a.facts.sourceHash).toBe(hash);
    expect(a.facts).toMatchObject({
      isUs: 1,
      isTech: 1,
      salaryMinAnnual: 100000,
      expMinYears: 3,
      countryCode: "US",
    });
    expect(new TextDecoder().decode(await gunzip(a.jd))).toBe(job.description);
    expect(
      (await prepareJob({ ...job, description: "Other text" }, source, hash)).facts.jdHash,
    ).not.toBe(a.facts.jdHash);
  });
});
