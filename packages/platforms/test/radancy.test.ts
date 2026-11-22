import { describe, expect, it } from "vitest";
import { platformFor, radancy } from "../src/index.ts";
import { drain, fakeCtx, fixture, source, textCtx, textFixture } from "./helpers.ts";

const att = source("radancy", "www.att.jobs");
const walgreens = source("radancy", "jobs.walgreens.com", { sitemapPath: "/en/sitemap.xml" });

const searchWalgreens = source("radancy", "jobs.walgreens.com", {
  searchPath: "/en/search-jobs/results",
});

/** A results page as the site reports it: `total` and the rows `ids`. */
const results = (total: number, ids: number[]) => ({
  filters: "",
  results:
    `<section id="search-results" data-total-results="${total}"><ul>` +
    ids.map((id) => `<li><a href="/en/job/town/job/1242/${id}">x</a></li>`).join("") +
    "</ul></section>",
});
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
const facet = (type: number, id: string, count: number) =>
  `<input data-facet-type="${type}" data-id="${id}" data-count="${count}">`;

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

  describe("search listing", () => {
    it("validates searchPath", () => {
      expect(() => radancy.validate(searchWalgreens)).not.toThrow();
      expect(() =>
        radancy.validate(source("radancy", "jobs.walgreens.com", { searchPath: "/search-jobs/" })),
      ).toThrow();
    });

    it("reads the recorded results page", async () => {
      // The site counts 22,363, over the cap, so the facets (recorded) split it into countries and states.
      const { ctx, urls } = fakeCtx((u) =>
        new URL(u).searchParams.get("IsPagination") === "False"
          ? {
              ...(fixture("radancy-walgreens-search") as object),
              filters: (fixture("radancy-walgreens-facets") as { filters: string }).filters,
            }
          : fixture("radancy-walgreens-search"),
      );
      const { items, result } = await drain(radancy.list(searchWalgreens, ctx));
      expect(items.map((i) => i.id)).toEqual(["103627694736", "103627694720"]);
      expect(urls.some((u) => u.includes("FacetFilters%5B0%5D.ID=6252001-4155751"))).toBe(true);
      expect(urls.some((u) => u.includes("FacetFilters%5B0%5D.ID=4566966&"))).toBe(true);
      expect(items[0]?.listing).toEqual({
        id: "103627694736",
        url: "https://jobs.walgreens.com/en/job/alameda/emerging-store-manager/1242/103627694736",
      });
      expect(urls[0]).toContain("/en/search-jobs/results?");
      // Two rows against a site total of 22,363 is not a full listing.
      expect(result.complete).toBe(false);
    });

    it("pages one query when the site fits under the cap", async () => {
      const { ctx, urls } = fakeCtx((u) => {
        const q = new URL(u).searchParams;
        if (q.get("IsPagination") === "False") return results(130, range(1, 100));
        return results(130, q.get("CurrentPage") === "1" ? range(1, 100) : range(101, 30));
      });
      const { items, result } = await drain(radancy.list(searchWalgreens, ctx));
      expect(items).toHaveLength(130);
      expect(urls.some((u) => u.includes("CurrentPage=2"))).toBe(true);
      expect(result.complete).toBe(true);
    });

    it("splits an over-cap site by country and state and unions the parts", async () => {
      // 12,000 postings in the site: one country holds 10,500 of them over three states (one posting
      // sits in two of them), another country holds 1,500 and fits one query.
      const facets = [
        facet(2, "10", 10_500),
        facet(2, "20", 1_500),
        facet(3, "10-1", 4_000),
        facet(3, "10-2", 4_000),
        facet(3, "10-3", 2_501),
      ].join("");
      const slice: Record<string, [number, number]> = {
        "10-1": [1, 4_000],
        "10-2": [4_001, 4_000],
        "10-3": [8_000, 2_501],
        "20": [10_501, 1_500],
      };
      const { ctx, urls } = fakeCtx((u) => {
        const q = new URL(u).searchParams;
        if (q.get("IsPagination") === "False") return { ...results(12_000, []), filters: facets };
        const [from, n] = slice[q.get("FacetFilters[0].ID") ?? ""] ?? [0, 0];
        const page = Number(q.get("CurrentPage"));
        return results(n, range(from + (page - 1) * 100, Math.min(100, n - (page - 1) * 100)));
      });
      const { items, result } = await drain(radancy.list(searchWalgreens, ctx));
      expect(items).toHaveLength(12_000);
      expect(urls.some((u) => u.includes("FacetFilters%5B0%5D.ID=10-1"))).toBe(true);
      // The over-cap country is split into states, never queried whole.
      expect(urls.some((u) => /FacetFilters%5B0%5D\.ID=10&/.test(u))).toBe(false);
      expect(result.complete).toBe(true);
    });

    it("is incomplete when the parts fall short of the site total", async () => {
      const facets = [facet(2, "10", 15_000), facet(3, "10-1", 60)].join("");
      const { ctx, issues } = fakeCtx((u) => {
        const q = new URL(u).searchParams;
        if (q.get("IsPagination") === "False") return { ...results(15_000, []), filters: facets };
        return results(60, range(1, 60));
      });
      const { items, result } = await drain(radancy.list(searchWalgreens, ctx));
      expect(items).toHaveLength(60);
      expect(result.complete).toBe(false);
      expect(issues[0]?.code).toBe("pagination");
    });

    it("rejects a response that is not a results page", async () => {
      const { ctx } = fakeCtx(() => ({ results: "<html/>" }));
      await expect(drain(radancy.list(searchWalgreens, ctx))).rejects.toThrow();
    });
  });
});
