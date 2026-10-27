import { jobFactsSchema } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { gunzip, htmlToText, prepareJob, sourceLocation } from "../src/index.ts";

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

describe("sourceLocation", () => {
  it("never reads city, region, country or remote out of the text", () => {
    for (const text of [
      "Austin, TX",
      "Remote - USA",
      "Tokyo, Japan",
      "Remote",
      "Joliet,IL 60436",
    ]) {
      expect(sourceLocation(text)).toEqual({ text });
    }
  });
  it("keeps the source's own structured fields as given", () => {
    expect(
      sourceLocation("Austin", {
        city: "Austin",
        region: "Texas",
        countryCode: "US",
        remote: false,
      }),
    ).toEqual({
      text: "Austin",
      city: "Austin",
      region: "Texas",
      countryCode: "US",
      remote: false,
    });
  });
  it("turns a structured country name into a code only through the ISO tables", () => {
    expect(sourceLocation("Berlin", { country: "Germany" }).countryCode).toBe("DE");
    expect(sourceLocation("NYC", { country: "United States" }).countryCode).toBe("US");
    expect(sourceLocation("London", { country: "UK" }).countryCode).toBe("GB");
    expect(sourceLocation("Nowhere", { country: "Narnia" }).countryCode).toBeUndefined();
  });
  it("collapses whitespace in the text", () => {
    expect(sourceLocation("  Austin,\n  TX ").text).toBe("Austin, TX");
  });
});

describe("prepareJob", () => {
  const source = { id: "x:y", platform: "x", key: "y", company: "Y", params: {} };
  const job = {
    postingId: "1",
    title: "Software Engineer",
    description: "Build things. 3+ years of experience. $100,000 - $120,000 per year.",
    locations: [{ text: "Austin, TX", primary: true }],
    compensation: [],
    experience: [],
    extras: {},
  };
  it("keeps oversized source locations in facts while bounding indexed display fields", async () => {
    // Ashby alan supplied a list of cities as addressLocality. Greenhouse
    // bestversionmedia supplied sales prose as location.name.
    const city =
      "Paris, France; Bordeaux, France; Lyon, France; Marseille, France; Biarritz, France; Nantes, France; Annecy, France; Madrid, Spain; Barcelona, Spain";
    const locations = [
      {
        text: "Outside sales opportunity. ".repeat(25),
        city,
        region: "r".repeat(121),
        primary: true,
      },
    ];
    const prepared = await prepareJob({ ...job, locations }, source, "a".repeat(64));
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
    expect(prepared.facts.locationText).toHaveLength(500);
    expect(prepared.facts.locationText).toMatch(/…$/);
    expect(prepared.facts.city).toBeNull();
    expect(prepared.facts.region).toBeNull();
    expect(prepared.facts.facts.locations).toEqual(locations);
  });

  it.each([120, 121])(
    "keeps complete city and region names only within the %i-character boundary",
    async (length) => {
      const name = "x".repeat(length);
      const prepared = await prepareJob(
        { ...job, locations: [{ text: "A place", city: name, region: name }] },
        source,
        "a".repeat(64),
      );
      expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
      expect(prepared.facts.city).toBe(length === 120 ? name : null);
      expect(prepared.facts.region).toBe(length === 120 ? name : null);
    },
  );

  it.each([500, 501])(
    "bounds a %i-character location label without changing its stored evidence",
    async (length) => {
      const text = "x".repeat(length);
      const prepared = await prepareJob({ ...job, locations: [{ text }] }, source, "a".repeat(64));
      expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
      expect(prepared.facts.locationText).toHaveLength(500);
      if (length === 500) expect(prepared.facts.locationText).toBe(text);
      expect(prepared.facts.facts.locations).toEqual([{ text }]);
    },
  );

  it("stores only what the source stated: no derived flags, no text-parsed pay or experience", async () => {
    const prepared = await prepareJob(
      { ...job, locations: [{ text: "Remote - USA", primary: true }] },
      source,
      "a".repeat(64),
    );
    expect(prepared.facts).toMatchObject({ workMode: null, countryCode: null, city: null });
    expect(prepared.facts.facts).toMatchObject({ compensation: [], experience: [] });
    for (const removed of [
      "isUs",
      "isTech",
      "classifierVersion",
      "hidden",
      "salaryMinAnnual",
      "expMinYears",
    ]) {
      expect(prepared.facts).not.toHaveProperty(removed);
    }
  });

  it("keeps source compensation and experience losslessly, in their own interval", async () => {
    const compensation = [
      { min: 50, max: 60, currency: "USD", interval: "hour" as const, component: "base" as const },
    ];
    const experience = [{ min: 3, unit: "years" as const, kind: "required" as const }];
    const prepared = await prepareJob({ ...job, compensation, experience }, source, "a".repeat(64));
    expect(prepared.facts.facts).toMatchObject({ compensation, experience });
  });

  it("derives facts and round-trips the JD", async () => {
    const hash = "a".repeat(64);
    const a = await prepareJob(job, source, hash);
    expect(a.facts.sourceHash).toBe(hash);
    expect(a.facts).toMatchObject({ countryCode: null, title: "Software Engineer" });
    expect(new TextDecoder().decode(await gunzip(a.jd))).toBe(job.description);
    expect(
      (await prepareJob({ ...job, description: "Other text" }, source, hash)).facts.jdHash,
    ).not.toBe(a.facts.jdHash);
  });
});
