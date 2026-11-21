import { readdirSync, readFileSync } from "node:fs";
import { jobFactsSchema } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { boundFacts, prepareJob, slug } from "../src/index.ts";

const legacy = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const dir = new URL("../../../sources/", import.meta.url);
const companies = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && f !== "hot.json")
  .flatMap((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { company?: string }[])
  .flatMap((s) => (s.company ? [s.company] : []));

describe("slug", () => {
  it("is byte-identical to the previous rule for every configured company", () => {
    expect(companies.length).toBeGreaterThan(1000);
    const changed = companies.filter((c) => slug(c) !== legacy(c));
    expect(changed).toEqual([]);
  });

  it("keeps accented Latin names as stored (no re-slug)", () => {
    expect(slug("Grüns")).toBe("gr-ns");
    expect(slug("The Pokémon Company International")).toBe("the-pok-mon-company-international");
  });

  it("keeps letters of other scripts", () => {
    expect(slug("株式会社 テスト")).toBe("株式会社-テスト");
    expect(slug("Яндекс")).toBe("яндекс");
    expect(slug("Яндекс Cloud")).toBe("яндекс-cloud");
    expect(slug("شركة")).toBe("شركة");
  });

  it("gives different non-Latin names different slugs", () => {
    expect(slug("株式会社A")).not.toBe(slug("株式会社B"));
  });

  it("falls back to a stable hash, never empty", () => {
    const a = slug("®©");
    expect(a).toMatch(/^c-[0-9a-f]{14}$/);
    expect(slug("®©")).toBe(a);
    expect(slug("®®")).not.toBe(a);
    expect(slug("")).toMatch(/^c-/);
  });
});

const facts = () => ({
  postingId: "p1",
  title: "Engineer",
  url: "https://x.test/1",
  applyUrl: null,
  locationText: null,
  city: null,
  region: null,
  countryCode: null,
  workMode: null,
  department: null,
  team: null,
  employmentType: null,
  requisitionId: null,
  postedAt: null,
  sourceUpdatedAt: null,
  expiresAt: null,
  excerpt: "x",
  jdHash: "a".repeat(64),
  dedupeKey: null,
  jdBytes: 1,
  sourceHash: "b".repeat(64),
  facts: { platform: "greenhouse", locations: [], compensation: [], experience: [], extras: {} },
});

describe("boundFacts", () => {
  it("leaves a posting in bounds untouched", () => {
    const f = facts();
    const out = boundFacts(f);
    expect(out.notes).toEqual([]);
    expect(out.facts).toEqual(f);
  });

  it("nulls oversize stated fields, cuts the title, and the result passes the wire schema", () => {
    const out = boundFacts({
      ...facts(),
      title: "t".repeat(900),
      url: `https://x.test/${"u".repeat(2100)}`,
      applyUrl: "a".repeat(2049),
      department: "d".repeat(201),
      team: "t".repeat(201),
      employmentType: "e".repeat(101),
      requisitionId: "r".repeat(201),
    });
    expect(jobFactsSchema.safeParse(out.facts).success).toBe(true);
    expect(out.facts.title).toHaveLength(500);
    for (const k of [
      "url",
      "applyUrl",
      "department",
      "team",
      "employmentType",
      "requisitionId",
    ] as const)
      expect(out.facts[k]).toBeNull();
    expect(out.notes).toHaveLength(7);
  });

  it("does not split a surrogate pair when cutting a title", () => {
    const out = boundFacts({ ...facts(), title: `${"a".repeat(498)}😀😀` });
    expect(out.facts.title.length).toBeLessThanOrEqual(500);
    expect(jobFactsSchema.safeParse(out.facts).success).toBe(true);
    expect(out.facts.title).not.toMatch(/[\ud800-\udbff]…$/);
  });

  it("caps facts arrays and total facts size", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ text: `City ${i}` }));
    const out = boundFacts({
      ...facts(),
      facts: { ...facts().facts, locations: many, compensation: many, experience: many },
    });
    const rich = out.facts.facts as Record<string, unknown[]>;
    expect(rich.locations).toHaveLength(100);
    expect(rich.compensation).toHaveLength(50);
    expect(rich.experience).toHaveLength(50);

    const big = boundFacts({
      ...facts(),
      facts: {
        ...facts().facts,
        locations: Array.from({ length: 100 }, () => ({ text: "x".repeat(1000) })),
      },
    });
    const bigRich = big.facts.facts as Record<string, unknown>;
    expect((bigRich.locations as unknown[]).length).toBe(10);
    expect(bigRich.extras).toEqual({});
    expect(JSON.stringify(big.facts.facts).length).toBeLessThanOrEqual(32 * 1024);
  });

  it("throws only for an unusable posting id", () => {
    expect(() => boundFacts({ ...facts(), postingId: "p".repeat(513) })).toThrow(/postingId/);
    expect(() => boundFacts({ ...facts(), postingId: "" })).toThrow(/postingId/);
  });
});

describe("prepareJob bounds", () => {
  it("reports notes and still produces schema-valid facts", async () => {
    const out = await prepareJob(
      {
        postingId: "p1",
        title: "T".repeat(700),
        url: "https://x.test/".padEnd(2200, "u"),
        description: "d",
        locations: Array.from({ length: 150 }, (_, i) => ({ text: `L${i}` })),
        compensation: [],
        experience: [],
        extras: {},
      },
      { id: "greenhouse:a", platform: "greenhouse", key: "a", company: "A", params: {} },
      "a".repeat(64),
    );
    expect(jobFactsSchema.safeParse(out.facts).success).toBe(true);
    expect(out.notes.length).toBeGreaterThanOrEqual(3);
  });
});
