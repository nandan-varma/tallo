import { describe, expect, it } from "vitest";
import { platformFor, walmart } from "../src/index.ts";
import { drain, fixture, source, textCtx } from "./helpers.ts";

const src = source("walmart", "walmart");
const sitemap = `<urlset><url><loc>https://careers.walmart.com/us/en/home</loc></url>
<url><loc>https://careers.walmart.com/us/en/jobs/R-1</loc></url>
<url><loc>https://careers.walmart.com/us/en/jobs/R-2</loc></url>
<url><loc>https://careers.walmart.com/us/en/jobs/R-2</loc></url></urlset>`;

describe("walmart", () => {
  it("calls a job-not-found page a gone posting, not a broken one", async () => {
    const page = `<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"path":"/us/en/job-not-found"}}}</script></html>`;
    const { ctx } = textCtx(page);
    const posting = { id: "R-404", listing: { id: "R-404", url: "x" } };
    await expect(walmart.detail!(src, posting, ctx)).rejects.toThrow(/is gone \(job-not-found\)/);
  });

  it("is registered and validates its key", () => {
    expect(platformFor(src).id).toBe("walmart");
    expect(() => walmart.validate(source("walmart", "other"))).toThrow();
  });

  it("lists posting ids from the sitemap once each", async () => {
    const { ctx, urls } = textCtx(sitemap);
    const { items, result } = await drain(walmart.list(src, ctx));
    expect(items.map((i) => i.id)).toEqual(["R-1", "R-2"]);
    expect(urls).toHaveLength(1);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("rejects an unexpected sitemap", async () => {
    await expect(drain(walmart.list(src, textCtx("<html/>").ctx))).rejects.toThrow();
  });

  it("detail reads the embedded page data and fails on a missing job page", async () => {
    const page = `<script id=__NEXT_DATA__ type="application/json">${JSON.stringify({ props: { pageProps: fixture("walmart-detail") } })}</script>`;
    const got = await walmart.detail?.(src, { id: "R-2701127", listing: {} }, textCtx(page).ctx);
    expect(got).toHaveProperty("jobDetails.jobId", "R-2701127");
    await expect(
      walmart.detail?.(src, { id: "R-9", listing: {} }, textCtx("<html/>").ctx),
    ).rejects.toThrow();
  });

  it("maps the posting", () => {
    const job = walmart.map(
      { id: "R-2701127", listing: {}, detail: fixture("walmart-detail") },
      src,
    );
    expect(job.title).toContain("Group Director");
    expect(job.url).toBe("https://careers.walmart.com/us/en/jobs/R-2701127");
    expect(job.compensation[0]).toMatchObject({ min: 254000, max: 481000, interval: "year" });
    expect(job.locations[0]?.city).toBe("SAN BRUNO");
    expect(job.department).toBe("Technology");
    expect(job.extras).toHaveProperty("recruitingStartDate");
    expect(job.extras).toHaveProperty("createdAt");
    expect(job.extras.shifts).toEqual([
      { id: "WeekdayDay", value: "Weekday Day" },
      { id: "WeekendDay", value: "Weekend Day" },
    ]);
  });
});
