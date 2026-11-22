import { prepareJob } from "@tallo/catalog";
import { jobFactsSchema } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { fedex, platformFor } from "../src/index.ts";
import { drain, source, textCtx, textFixture } from "./helpers.ts";

const src = source("fedex", "careers.fedex.com");
const sha = "a".repeat(64);
const url = (id: string, slug = "job-title") =>
  `<url><loc>https://careers.fedex.com/${slug}/job/${id}</loc><lastmod>2026-11-22T01:00:00Z</lastmod></url>`;
const sitemap = (...urls: string[]) => `<urlset>${urls.join("")}</urlset>`;

describe("fedex", () => {
  it("is registered and accepts only its host as the key", () => {
    expect(platformFor(src).id).toBe("fedex");
    expect(() => platformFor(source("fedex", "example.com"))).toThrow(/careers\.fedex\.com/);
  });

  it("reads exactly the two English sitemaps and lists each posting once", async () => {
    const { ctx, urls } = textCtx(
      sitemap(url("P25-1-1"), url("0021BDBF8A5EDEF98008A1D096752FC3"), url("P25-1-1")),
    );
    const { items, result } = await drain(fedex.list(src, ctx));
    expect(urls).toEqual([
      "https://careers.fedex.com/sitemap-a0a4453b-en.xml",
      "https://careers.fedex.com/sitemap-c84076ce-en.xml",
    ]);
    expect(items.map((i) => i.id)).toEqual(["P25-1-1", "0021BDBF8A5EDEF98008A1D096752FC3"]);
    expect(items[0]?.listing).toEqual({
      id: "P25-1-1",
      url: "https://careers.fedex.com/job-title/job/P25-1-1",
    });
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("lists the recorded sitemap slice and skips other hosts", async () => {
    const other = "<url><loc>https://elsewhere.example/a/job/X1</loc></url></urlset>";
    const xml = textFixture("fedex-sitemap.xml").replace("</urlset>", other);
    const { items } = await drain(fedex.list(src, textCtx(xml).ctx));
    expect(items.map((i) => i.id)).toEqual(["P25-394285-1", "P25-331783-2", "P25-394218-1"]);
  });

  it("rejects a sitemap that is not a urlset", async () => {
    await expect(drain(fedex.list(src, textCtx("<html/>").ctx))).rejects.toThrow();
  });

  it("detail reads the JSON-LD and the apply link, and fails on a page without JSON-LD", async () => {
    const posting = {
      id: "P25-394285-1",
      listing: { url: "https://careers.fedex.com/a/job/P25-394285-1" },
    };
    const { ctx, urls } = textCtx(textFixture("fedex-us-page.html"));
    expect(await fedex.detail?.(src, posting, ctx)).toMatchObject({
      jsonLd: { "@type": "JobPosting", title: "Courier/Swing Drvr/DOT" },
      applyUrl: expect.stringContaining("fedex.paradox.ai"),
    });
    expect(urls).toEqual([posting.listing.url]);
    await expect(fedex.detail?.(src, posting, textCtx("<html/>").ctx)).rejects.toThrow();
  });

  it("turns a 404 page into a gone posting", async () => {
    const { ctx } = textCtx("");
    ctx.http.getText = async () => {
      throw Object.assign(new Error("404"), { status: 404 });
    };
    const posting = { id: "P25-1-1", listing: { url: "https://careers.fedex.com/a/job/P25-1-1" } };
    await expect(fedex.detail?.(src, posting, ctx)).rejects.toThrow(/gone/);
  });

  it("maps the US posting", async () => {
    const { ctx } = textCtx(textFixture("fedex-us-page.html"));
    const posting = {
      id: "P25-394285-1",
      listing: { url: "https://careers.fedex.com/a/job/P25-394285-1" },
    };
    const detail = await fedex.detail?.(src, posting, ctx);
    const job = fedex.map({ id: posting.id, listing: posting.listing, detail }, src);
    expect(job).toMatchObject({
      postingId: "P25-394285-1",
      title: "Courier/Swing Drvr/DOT",
      requisitionId: "P25-394285-1",
      employmentType: "FULL_TIME",
      postedAt: "2026-11-15T21:57:30.788527+00:00",
      compensation: [],
      extras: { organization: "Federal Express Corporation", directApply: true },
    });
    expect(job.applyUrl).toContain("fedex.paradox.ai");
    expect(job.locations[0]).toMatchObject({ primary: true, text: "St. Joseph, MO, US" });
    expect(job.description).toMatch(/delivery and pick up of packages/);
    expect(jobFactsSchema.safeParse((await prepareJob(job, src, sha)).facts).success).toBe(true);
  });

  it("maps the international posting with its Workday apply link", async () => {
    const { ctx } = textCtx(textFixture("fedex-eu-page.html"));
    const posting = { id: "0021", listing: { url: "https://careers.fedex.com/a/job/0021" } };
    const detail = await fedex.detail?.(src, posting, ctx);
    const job = fedex.map({ id: posting.id, listing: posting.listing, detail }, src);
    expect(job).toMatchObject({ title: "Handler (Nights)", requisitionId: "RC787233" });
    expect(job.applyUrl).toContain("myworkdayjobs.com");
    expect(job.locations[0]?.text).toBe("Crawley, England, GB");
  });
});
