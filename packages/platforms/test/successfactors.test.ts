import { prepareJob } from "@tallo/catalog";
import { jobFactsSchema } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { PostingGone, platformFor, successfactors } from "../src/index.ts";
import { drain, source, textCtx, textFixture } from "./helpers.ts";

const src = source("successfactors", "careers.jetblue.com");
const sha = "a".repeat(64);
const sitemap = (...ids: string[]) =>
  `<urlset>${ids
    .map(
      (id) =>
        `<url><loc>https://careers.jetblue.com/job/Boston-Analyst-%28A%29-MA-02128/${id}/</loc><lastmod>2026-11-21</lastmod></url>`,
    )
    .join("")}</urlset>`;

describe("successfactors", () => {
  it("is registered and accepts only reviewed sites", () => {
    expect(platformFor(src).id).toBe("successfactors");
    expect(() => platformFor(source("successfactors", "example.com"))).toThrow(/Unknown/);
  });

  it("lists each posting once from the sitemap, with its url", async () => {
    const { ctx, urls } = textCtx(sitemap("1435275200", "1453825400", "1435275200"));
    const { items, result } = await drain(successfactors.list(src, ctx));
    expect(urls).toEqual(["https://careers.jetblue.com/sitemap.xml"]);
    expect(items.map((i) => i.id)).toEqual(["1435275200", "1453825400"]);
    expect(items[0]?.listing).toEqual({
      id: "1435275200",
      url: "https://careers.jetblue.com/job/Boston-Analyst-%28A%29-MA-02128/1435275200",
    });
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("reads an RSS feed's job links and skips other hosts", async () => {
    const xml =
      "<rss><channel><item><link>https://careers.jetblue.com/Tenant/job/A-B/111111/</link></item>" +
      "<item><link>https://elsewhere.example/job/A-B/222222/</link></item></channel></rss>";
    const { items } = await drain(successfactors.list(src, textCtx(xml).ctx));
    expect(items.map((i) => i.id)).toEqual(["111111"]);
  });

  it("refuses a sitemap that is not a urlset or feed", async () => {
    await expect(drain(successfactors.list(src, textCtx("<html></html>").ctx))).rejects.toThrow(
      /neither/,
    );
  });

  it("reads the posting's microdata and maps it", async () => {
    const posting = {
      id: "1435275200",
      listing: { id: "1435275200", url: "https://careers.jetblue.com/job/x/1435275200/" },
    };
    const { ctx } = textCtx(textFixture("successfactors-job.html"));
    const detail = await successfactors.detail?.(src, posting, ctx);
    const job = successfactors.map({ ...posting, detail }, src);
    expect(job.title).toBe("Senior Analyst FP&A (Commercial)");
    expect(job.department).toBe("Finance");
    expect(job.postedAt).toBe("2026-10-29T07:00:00.000Z");
    expect(job.applyUrl).toBe(
      "https://careers.jetblue.com/talentcommunity/apply/1435275200/?locale=en_US",
    );
    expect(job.locations[0]).toMatchObject({
      city: "Long Island City",
      region: "NY",
      country: "US",
    });
    expect(job.description).toContain("Position Summary");
    expect(jobFactsSchema.safeParse((await prepareJob(job, src, sha)).facts).success).toBe(true);
  });

  it("treats a page without the posting as gone", async () => {
    const posting = { id: "1", listing: { url: "https://careers.jetblue.com/job/x/1/" } };
    const { ctx } = textCtx("<html><body>not found</body></html>");
    await expect(successfactors.detail?.(src, posting, ctx)).rejects.toBeInstanceOf(PostingGone);
  });
});
