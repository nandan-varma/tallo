import { readFileSync } from "node:fs";
import type { CollectContext, RawPosting } from "@tallo/contracts";
import { obj } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { platformFor, SchemaError, teamtailor } from "../src/index.ts";
import { drain, source } from "./helpers.ts";

describe("teamtailor", () => {
  const src = source("teamtailor", "dustin");
  const feed = readFileSync(new URL("./fixtures/teamtailor-list.rss", import.meta.url), "utf8");
  const item = (guid: string) =>
    `<item><title>T${guid}</title><guid>${guid}</guid><link>https://x/${guid}</link></item>`;
  const wrap = (items: string) =>
    `<?xml version="1.0"?><rss version="2.0" xmlns:tt="https://teamtailor.com/locations"><channel><title>x</title>${items}</channel></rss>`;
  const ctxFor = (answer: (url: string) => string) => {
    const urls: string[] = [];
    const ctx: CollectContext = {
      http: {
        getText: async (url: string) => {
          urls.push(url);
          return { status: 200, url, data: answer(url) };
        },
      } as unknown as CollectContext["http"],
      maxPostings: 1_000_000,
      record: () => {},
    };
    return { ctx, urls };
  };

  it("lists every item of the feed untouched, keyed by guid", async () => {
    const { ctx, urls } = ctxFor(() => feed);
    const { items, result } = await drain(teamtailor.list(src, ctx));
    expect(urls).toEqual(["https://dustin.teamtailor.com/jobs.rss"]);
    expect(items.map((i) => i.id)).toEqual([
      "cfbf9ee6-527a-4579-8f6d-88083859f5a4",
      "2f68b5aa-5261-48a3-ab3a-af31943bc9ca",
    ]);
    expect(obj(items[0]?.listing)["tt:department"]).toBe("Operations");
    expect(Object.hasOwn(obj(obj(obj(items[1]?.listing)["tt:locations"])), "tt:location")).toBe(
      true,
    );
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });
  it("maps structured fields only and keeps zip codes as text", async () => {
    const { ctx } = ctxFor(() => feed);
    const { items } = await drain(teamtailor.list(src, ctx));
    const hybrid = teamtailor.map(items[0] as RawPosting, src);
    expect(hybrid).toMatchObject({
      postingId: "cfbf9ee6-527a-4579-8f6d-88083859f5a4",
      title: "Inside Sales Representative",
      url: "https://jobs.dustin.com/jobs/8770427-inside-sales-representative",
      workMode: "hybrid",
      department: "Operations",
      postedAt: "2026-11-19T15:19:27.000Z",
      compensation: [],
      experience: [],
      extras: { role: "Order executive" },
    });
    expect(hybrid.locations).toEqual([
      {
        text: "Nijmegen, Netherlands",
        city: "Nijmegen",
        country: "Netherlands",
        countryCode: "NL",
        primary: true,
      },
    ]);
    expect(hybrid.description).toMatch(/^Wil jij het verschil/);
    const multi = teamtailor.map(items[1] as RawPosting, src);
    expect(multi.workMode).toBeUndefined();
    expect(multi.locations.map((l) => l.text)).toEqual([
      "Gurugram, India",
      "Singapore, Singapore",
      "Preston, Australia",
      "Sydney, Australia",
    ]);
    expect(multi.extras).toEqual({});
  });
  it("follows offset while answers are full, then stops on a short one", async () => {
    const page = (from: number, n: number) =>
      wrap(Array.from({ length: n }, (_, i) => item(`g${from + i}`)).join(""));
    const { ctx, urls } = ctxFor((url) =>
      url.endsWith("offset=100") ? page(100, 12) : page(0, 100),
    );
    const { items, result } = await drain(teamtailor.list(src, ctx));
    expect(items).toHaveLength(112);
    expect(urls).toEqual([
      "https://dustin.teamtailor.com/jobs.rss",
      "https://dustin.teamtailor.com/jobs.rss?offset=100",
    ]);
    expect(result.complete).toBe(true);
  });
  it("reports incomplete when offset paging repeats items", async () => {
    const full = wrap(Array.from({ length: 100 }, (_, i) => item(`g${i}`)).join(""));
    const { ctx } = ctxFor(() => full);
    const { items, result } = await drain(teamtailor.list(src, ctx));
    expect(items).toHaveLength(100);
    expect(result).toEqual({ complete: false, emptyIsAuthoritative: false });
  });
  it("treats an empty channel as an authoritatively empty board", async () => {
    const { ctx } = ctxFor(() => wrap(""));
    const { items, result } = await drain(teamtailor.list(src, ctx));
    expect(items).toEqual([]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });
  it("throws a SchemaError on HTML, wrong roots and items without a guid", async () => {
    for (const body of [
      "<!DOCTYPE html><html><body>nope</body></html>",
      "not xml at all",
      '<rss version="2.0"></rss>',
      wrap("<item><title>no guid</title></item>"),
      wrap(item("one")).replace("</rss>", ""),
    ]) {
      const { ctx } = ctxFor(() => body);
      await expect(drain(teamtailor.list(src, ctx))).rejects.toThrow(SchemaError);
    }
  });
  it("supports the real North American regional host and rejects arbitrary host labels", async () => {
    const regional = source("teamtailor", "empower.na");
    expect(() => platformFor(regional)).not.toThrow();
    const { ctx, urls } = ctxFor(() => feed);
    await drain(teamtailor.list(regional, ctx));
    expect(urls).toEqual(["https://empower.na.teamtailor.com/jobs.rss"]);
    for (const key of ["empower.evil.com", "empower.na.evil", "empower..na", "empower.na/"])
      expect(() => platformFor(source("teamtailor", key))).toThrow(/Invalid/);
  });

  it("rejects malformed keys", () => {
    expect(() => platformFor(source("teamtailor", "a.b/../c"))).toThrow(/Invalid/);
    expect(() => platformFor(source("teamtailor", "career"))).not.toThrow();
  });
});
