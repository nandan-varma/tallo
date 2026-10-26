import type { MappedJob, SourceConfig } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { dedupeKey, normalizeCompany, normalizeTitle, prepareJob, sha256 } from "../src/index.ts";

const JD = "a".repeat(64);
const key = (company: string, title: string, jdHash = JD) => dedupeKey({ company, title, jdHash });

describe("normalizeCompany", () => {
  it("ignores case, punctuation and a trailing legal suffix", () => {
    expect(normalizeCompany("Klaviyo")).toBe(normalizeCompany("klaviyo"));
    expect(normalizeCompany("Innodata Inc.")).toBe(normalizeCompany("Innodata"));
    expect(normalizeCompany("Nextdoor, Inc.")).toBe(normalizeCompany("Nextdoor"));
    expect(normalizeCompany("Bridgewater Associates LP")).toBe(
      normalizeCompany("Bridgewater Associates"),
    );
  });

  it("keeps words that distinguish an employer", () => {
    expect(normalizeCompany("Soho House & Co.")).toBe("soho house and co");
    expect(normalizeCompany("Soho House")).not.toBe(normalizeCompany("Soho House & Co."));
    expect(normalizeCompany("Apex ABA Therapy")).not.toBe(normalizeCompany("Apex ABA"));
    expect(normalizeCompany("Inc")).toBe("inc");
  });
});

describe("normalizeTitle", () => {
  it("treats punctuation and spacing as noise", () => {
    expect(normalizeTitle("Product / Event Demonstrator")).toBe(
      normalizeTitle("Product/Event Demonstrator"),
    );
    expect(normalizeTitle("  Senior   Engineer ")).toBe("senior engineer");
  });

  it("keeps different job titles apart", () => {
    expect(normalizeTitle("Senior Engineer")).not.toBe(normalizeTitle("Staff Engineer"));
  });
});

describe("dedupeKey", () => {
  it("is a sha256 hex digest", async () => {
    expect(await key("Acme", "Engineer")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is equal for the same posting spelled differently", async () => {
    expect(await key("Acme, Inc.", "Product / Event Demonstrator")).toBe(
      await key("acme", "Product/Event Demonstrator"),
    );
  });

  it("separates postings that differ in company, title or description", async () => {
    const base = await key("Acme", "Engineer");
    expect(await key("Apex", "Engineer")).not.toBe(base);
    expect(await key("Acme", "Designer")).not.toBe(base);
    expect(await key("Acme", "Engineer", "b".repeat(64))).not.toBe(base);
  });

  it("does not mix company and title words", async () => {
    // Without a separator these would both read "acmeengineer".
    expect(await key("Acme Engineer", "Lead")).not.toBe(await key("Acme", "Engineer Lead"));
  });
});

describe("prepareJob", () => {
  const source: SourceConfig = {
    id: "lever:acme",
    platform: "lever",
    key: "acme",
    company: "Acme, Inc.",
    params: {},
  };
  const job = (over: Partial<MappedJob> = {}): MappedJob => ({
    postingId: "p1",
    title: "Software Engineer",
    description: "Build things",
    locations: [{ text: "Austin, TX", countryCode: "US", primary: true }],
    compensation: [],
    experience: [],
    extras: {},
    ...over,
  });

  it("stores the key of the source company, title and description hash", async () => {
    const { facts } = await prepareJob(job(), source, "c".repeat(64));
    expect(facts.dedupeKey).toBe(
      await dedupeKey({
        company: "Acme, Inc.",
        title: "Software Engineer",
        jdHash: await sha256("Build things"),
      }),
    );
  });

  it("gives the same key to the same posting listed in another location", async () => {
    const austin = await prepareJob(job(), source, "c".repeat(64));
    const denver = await prepareJob(
      job({
        postingId: "p2",
        locations: [{ text: "Denver, CO", countryCode: "US", primary: true }],
      }),
      source,
      "d".repeat(64),
    );
    expect(denver.facts.dedupeKey).toBe(austin.facts.dedupeKey);
  });
});
