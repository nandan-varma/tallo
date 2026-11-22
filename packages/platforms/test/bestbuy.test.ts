import { prepareJob } from "@tallo/catalog";
import type { Json } from "@tallo/contracts";
import { jobFactsSchema } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { bestbuy, platformFor, SchemaError } from "../src/index.ts";
import { drain, fakeCtx, fixture, source, textCtx, textFixture } from "./helpers.ts";

const src = source("bestbuy", "jobs.bestbuy.com");
const sha = "a".repeat(64);

describe("bestbuy", () => {
  it("is registered and accepts only its host as the key", () => {
    expect(platformFor(src).id).toBe("bestbuy");
    expect(() => platformFor(source("bestbuy", "example.com"))).toThrow(/jobs\.bestbuy\.com/);
  });

  it("lists the job pages of the sitemap and nothing else", async () => {
    const { ctx, urls } = textCtx(textFixture("bestbuy-sitemap.xml"));
    const { items, result } = await drain(bestbuy.list(src, ctx));
    expect(urls).toEqual(["https://bestbuy.service-now.com/api/93622/seo/sitemap"]);
    expect(items.map((i) => i.id)).toEqual(["1056996BR", "1056984BR"]);
    expect(items[0]?.listing).toEqual({
      id: "1056996BR",
      url: "https://jobs.bestbuy.com/bby?id=job_details&req_id=1056996BR",
      lastmod: "2026-11-22",
    });
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("stops at the budget as incomplete and rejects a non-sitemap", async () => {
    const { ctx, issues } = (() => {
      const t = textCtx(textFixture("bestbuy-sitemap.xml"));
      const issues: unknown[] = [];
      t.ctx.maxPostings = 1;
      t.ctx.record = (i) => issues.push(i);
      return { ctx: t.ctx, issues };
    })();
    const { items, result } = await drain(bestbuy.list(src, ctx));
    expect(items).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(issues).toHaveLength(1);
    await expect(drain(bestbuy.list(src, textCtx("<html/>").ctx))).rejects.toThrow(SchemaError);
  });

  it("detail reads the portal page JSON and keeps only the job record", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("bestbuy-store-page"));
    const detail = await bestbuy.detail?.(src, { id: "1056996BR", listing: null }, ctx);
    expect(urls[0]).toContain("/api/now/sp/page?id=job_details&req_id=1056996BR&portal_id=");
    expect(Object.keys(detail as object)).toEqual(["job"]);
  });

  it("turns an empty job record into a gone posting", async () => {
    const empty: Json = {
      result: {
        containers: [{ rows: [{ columns: [{ widgets: [{ widget: { data: { job: {} } } }] }] }] }],
      },
    };
    const { ctx } = fakeCtx(() => empty);
    await expect(bestbuy.detail?.(src, { id: "X", listing: null }, ctx)).rejects.toThrow(/gone/);
    await expect(
      bestbuy.detail?.(src, { id: "X", listing: null }, fakeCtx(() => ({ result: {} })).ctx),
    ).rejects.toThrow(SchemaError);
  });

  it("maps a seasonal store posting with no stated pay", async () => {
    const { ctx } = fakeCtx(() => fixture("bestbuy-store-page"));
    const posting = {
      id: "1056996BR",
      listing: { url: "https://jobs.bestbuy.com/bby?id=job_details&req_id=1056996BR" },
    };
    const detail = await bestbuy.detail?.(src, posting, ctx);
    const job = bestbuy.map({ ...posting, detail }, src);
    expect(job).toMatchObject({
      postingId: "1056996BR",
      title: "Retail Warehouse Associate",
      department: "Retail Group",
      employmentType: "Part time",
      requisitionId: "1056996BR",
      updatedAt: "2026-11-21",
      compensation: [],
      extras: {
        workerType: "Occasional-Seasonal (Seasonal)",
        experienceLevel: "Individual Contributor",
      },
    });
    expect(job.applyUrl).toContain("brassring.com");
    expect(job.locations[0]).toMatchObject({
      primary: true,
      city: "Downers Grove",
      region: "Illinois",
    });
    expect(job.description).toMatch(/Retail Warehouse Associate/);
    expect(job.description).not.toMatch(/<\w+/);
    expect(jobFactsSchema.safeParse((await prepareJob(job, src, sha)).facts).success).toBe(true);
  });

  it("maps a stated hourly pay band", async () => {
    const { ctx } = fakeCtx(() => fixture("bestbuy-paid-page"));
    const posting = { id: "1056984BR", listing: null };
    const detail = await bestbuy.detail?.(src, posting, ctx);
    const job = bestbuy.map({ ...posting, detail }, src);
    expect(job.compensation).toEqual([
      { min: 16, max: 20.8, currency: "USD", interval: "hour", component: "base" },
    ]);
    expect(job.url).toBe("https://jobs.bestbuy.com/bby?id=job_details&req_id=1056984BR");
  });
});
