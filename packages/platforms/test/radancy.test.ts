import { describe, expect, it } from "vitest";
import { platformFor, radancy } from "../src/index.ts";
import { drain, fixture, source, textCtx, textFixture } from "./helpers.ts";

const att = source("radancy", "www.att.jobs");
const walgreens = source("radancy", "jobs.walgreens.com", { sitemapPath: "/en/sitemap.xml" });

const url = (host: string, id: number, lang = "") =>
  `<url><loc>https://${host}${lang}/job/town/some-job/1242/${id}</loc><lastmod>2026-11-22T01:00:00Z</lastmod></url>`;
const sitemap = (...urls: string[]) => `<urlset>${urls.join("")}</urlset>`;

describe("radancy", () => {
  it("is registered and validates its key and sitemap path", () => {
    expect(platformFor(att).id).toBe("radancy");
    expect(() => radancy.validate(att)).not.toThrow();
    expect(() => radancy.validate(walgreens)).not.toThrow();
    expect(() => radancy.validate(source("radancy", "example.com"))).toThrow();
    expect(() =>
      radancy.validate(source("radancy", "www.att.jobs", { sitemapPath: "//x" })),
    ).toThrow();
  });

  it("lists job pages from the sitemap once each, skipping other pages and hosts", async () => {
    const xml = sitemap(
      "<url><loc>https://www.att.jobs/category/sales-jobs/117/29158/1</loc></url>",
      url("www.att.jobs", 11),
      url("www.att.jobs", 11),
      url("www.att.jobs", 12),
      url("elsewhere.example", 13),
    );
    const { ctx, urls } = textCtx(xml);
    const { items, result } = await drain(radancy.list(att, ctx));
    expect(items.map((i) => i.id)).toEqual(["11", "12"]);
    expect(items[0]?.listing).toEqual({
      id: "11",
      url: "https://www.att.jobs/job/town/some-job/1242/11",
    });
    expect(urls).toEqual(["https://www.att.jobs/sitemap.xml"]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("reads the configured sitemap path and a language prefix", async () => {
    const { ctx, urls } = textCtx(sitemap(url("jobs.walgreens.com", 7, "/en")));
    const { items } = await drain(radancy.list(walgreens, ctx));
    expect(urls).toEqual(["https://jobs.walgreens.com/en/sitemap.xml"]);
    expect(items.map((i) => i.id)).toEqual(["7"]);
  });

  it("is incomplete when the sitemap holds exactly the 500-posting cap", async () => {
    const full = sitemap(
      ...Array.from({ length: 500 }, (_, i) => url("jobs.walgreens.com", i + 1)),
    );
    const { ctx } = textCtx(full);
    const { items, result } = await drain(radancy.list(walgreens, ctx));
    expect(items).toHaveLength(500);
    expect(result.complete).toBe(false);
  });

  it("rejects an unexpected sitemap", async () => {
    await expect(drain(radancy.list(att, textCtx("<html/>").ctx))).rejects.toThrow();
  });

  it("detail reads the JSON-LD and the apply link, and fails on a page without JSON-LD", async () => {
    const posting = { id: "103623609872", listing: { url: "https://www.att.jobs/job/x/y/117/1" } };
    const { ctx, urls } = textCtx(textFixture("radancy-att-page.html"));
    const got = await radancy.detail?.(att, posting, ctx);
    expect(got).toMatchObject({
      jsonLd: { "@type": "JobPosting", title: "Retail Sales Consultant" },
      applyUrl: expect.stringContaining("myworkdayjobs.com"),
    });
    expect(urls).toEqual([posting.listing.url]);
    await expect(radancy.detail?.(att, posting, textCtx("<html/>").ctx)).rejects.toThrow();
  });

  it("maps AT&T", () => {
    const job = radancy.map(
      { id: "103623609872", listing: {}, detail: fixture("radancy-att-detail") },
      att,
    );
    expect(job).toMatchObject({
      title: "Retail Sales Consultant",
      requisitionId: "R-128450",
      employmentType: "FULL_TIME",
      postedAt: "2026-11-22",
      expiresAt: "2027-04-05-07:00",
    });
    expect(job.applyUrl).toContain("myworkdayjobs.com");
    expect(job.locations[0]).toMatchObject({ city: "Jonesboro", countryCode: "US" });
    expect(job.extras).toMatchObject({ industry: "Sales", organization: "AT&T" });
  });

  it("maps Walgreens, whose country is unstated", () => {
    const job = radancy.map(
      { id: "103627694736", listing: {}, detail: fixture("radancy-walgreens-detail") },
      walgreens,
    );
    expect(job.title).toBe("Emerging Store Manager");
    expect(job.requisitionId).toBe("1934697BR");
    expect(job.locations[0]).toMatchObject({ city: "ALAMEDA", region: "CA" });
    expect(job.locations[0]?.countryCode).toBeUndefined();
    expect(job.applyUrl).toContain("brassring.com");
  });
});
