import { obj } from "@tallo/contracts";
import type { Json, RawPosting } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { ashby, greenhouse, lever, platformFor, smartrecruiters, workday } from "../src/index.ts";
import { drain, fakeCtx, fixture, source } from "./helpers.ts";

const jobs = (name: string, key: string): Json[] => obj(fixture(name))[key] as Json[];

describe("registry", () => {
  it("rejects unknown platforms and bad keys", () => {
    expect(() => platformFor(source("nope", "x"))).toThrow(/Unknown platform/);
    expect(() => platformFor(source("greenhouse", "../etc"))).toThrow(/Invalid/);
    expect(() => platformFor(source("workday", "target", {}))).toThrow(/tenant\/site/);
  });
});

describe("greenhouse", () => {
  const src = source("greenhouse", "stripe");
  it("lists every row with its listing untouched", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("greenhouse-list"));
    const { items, result } = await drain(greenhouse.list(src, ctx));
    expect(urls).toEqual(["https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true"]);
    expect(items.map((i) => i.listing)).toEqual(jobs("greenhouse-list", "jobs"));
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });
  it("maps pay transparency, locations and description from detail", () => {
    const detail = fixture("greenhouse-detail");
    const raw: RawPosting = { id: "5456619008", listing: detail, detail };
    const job = greenhouse.map(raw, source("greenhouse", "anthropic"));
    expect(job).toMatchObject({ postingId: "5456619008", title: "3P Revenue Accounting & Reporting", department: "Finance" });
    expect(job.compensation[0]).toMatchObject({ min: 190000, max: 230000, currency: "USD", interval: "year", component: "base" });
    expect(job.locations.map((l) => l.text)).toEqual(expect.arrayContaining(["San Francisco, CA", "Seattle, WA"]));
    expect(job.locations[0]).toMatchObject({ primary: true, countryCode: "US" });
    expect(job.description.length).toBeGreaterThan(500);
    expect(job.description).not.toContain("<");
  });
  it("fetches pay detail by posting id", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("greenhouse-detail"));
    await greenhouse.detail!(src, { id: "42", listing: null }, ctx);
    expect(urls[0]).toBe("https://boards-api.greenhouse.io/v1/boards/stripe/jobs/42?questions=true&pay_transparency=true");
  });
  it("treats a malformed response as a failed run, not an empty board", async () => {
    const { ctx } = fakeCtx(() => ({ unexpected: true }));
    await expect(drain(greenhouse.list(src, ctx))).rejects.toThrow(/Expected array/);
  });
});

describe("lever", () => {
  const src = source("lever", "palantir");
  it("lists postings and maps the full description, categories and country", async () => {
    const { ctx } = fakeCtx(() => fixture("lever-list"));
    const { items, result } = await drain(lever.list(src, ctx));
    expect(items).toHaveLength(2);
    expect(result.emptyIsAuthoritative).toBe(false);
    const job = lever.map(items[0]!, src);
    expect(job.title).toBeTruthy();
    expect(job.locations[0]?.countryCode).toBe("SG");
    expect(job.workMode).toBe("hybrid");
    expect(job.department ?? job.team).toBeTruthy();
    expect(job.description.length).toBeGreaterThan(300);
    expect(job.postedAt).toMatch(/^\d{4}-/);
  });
  it("maps structured salary ranges with their interval", () => {
    const listing = { ...obj((fixture("lever-list") as Json[])[0]), salaryRange: { currency: "USD", interval: "per-hour-wage", min: 40, max: 55 } };
    const job = lever.map({ id: "x", listing }, src);
    expect(job.compensation).toEqual([{ min: 40, max: 55, currency: "USD", interval: "hour", component: "base" }]);
  });
});

describe("ashby", () => {
  const src = source("ashby", "ramp");
  it("maps components, secondary locations and workplace type", async () => {
    const { ctx } = fakeCtx(() => fixture("ashby-list"));
    const { items } = await drain(ashby.list(src, ctx));
    const job = ashby.map(items[0]!, src);
    expect(job.compensation.find((c) => c.component === "base")).toMatchObject({ currency: "USD", interval: "year" });
    expect(job.locations.length).toBeGreaterThan(0);
    expect(job.locations[0]?.countryCode).toBe("US");
    expect(job.description.length).toBeGreaterThan(300);
    expect(job.title).toBe(job.title.trim());
  });
  it("skips unlisted postings", async () => {
    const row = obj((jobs("ashby-list", "jobs") as Json[])[0]);
    const { ctx } = fakeCtx(() => ({ jobs: [row, { ...row, id: "hidden", isListed: false }] }));
    expect((await drain(ashby.list(src, ctx))).items).toHaveLength(1);
  });
});

describe("smartrecruiters", () => {
  const src = source("smartrecruiters", "servicenow");
  it("pages until totalFound and merges the detail job ad", async () => {
    const rowsFx = jobs("smartrecruiters-list", "content") as Json[];
    const { ctx, urls } = fakeCtx((url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      return { offset, limit: 100, totalFound: 150, content: offset === 0 ? rowsFx : [rowsFx[0]!] };
    });
    const { items } = await drain(smartrecruiters.list(src, ctx));
    expect(urls).toHaveLength(2);
    expect(items).toHaveLength(3);
    const detail = fixture("smartrecruiters-detail");
    const job = smartrecruiters.map({ id: "1", listing: rowsFx[0]!, detail }, src);
    expect(job).toMatchObject({ title: "Associate Software Engineer", requisitionId: "JB0076564", department: "Engineering, Infrastructure and Operations" });
    expect(job.locations[0]).toMatchObject({ countryCode: "US", city: "Santa Clara" });
    expect(job.description).toContain("Company Description");
    expect(job.extras).toHaveProperty("customFields");
  });
});

describe("workday", () => {
  const src = source("workday", "target/targetcareers", { wd: "wd5" });
  const list = fixture("workday-list") as { jobPostings: Json[] };
  const row = (n: number): Json => ({ ...obj(list.jobPostings[0]), externalPath: `/job/x/${n}` });

  it("pages a small board to the end", async () => {
    const all = Array.from({ length: 45 }, (_, i) => row(i));
    const { ctx } = fakeCtx((_u, body) => {
      const { offset } = obj(body) as { offset: number };
      return { total: 45, jobPostings: all.slice(offset, offset + 20), facets: [] };
    });
    const { items, result } = await drain(workday.list(src, ctx));
    expect(items).toHaveLength(45);
    expect(result.complete).toBe(true);
  });

  it("splits capped boards by facet and dedupes overlap", async () => {
    // 2 states with 30 jobs each; job 0 appears in both (multi-location).
    const states: Record<string, Json[]> = { a: Array.from({ length: 30 }, (_, i) => row(i)), b: Array.from({ length: 30 }, (_, i) => row(i + 29)) };
    const facets = [{ facetParameter: "state", values: [{ id: "a", count: 30 }, { id: "b", count: 30 }] }];
    const { ctx } = fakeCtx((_u, body) => {
      const { appliedFacets, offset } = obj(body) as { appliedFacets: Record<string, string[]>; offset: number };
      const id = appliedFacets.state?.[0];
      if (!id) return { total: 2000, jobPostings: Array.from({ length: 20 }, (_, i) => row(1000 + i)), facets };
      return { total: 30, jobPostings: states[id]!.slice(offset, offset + 20), facets: [] };
    });
    const { items, result } = await drain(workday.list(src, ctx));
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items.length).toBeGreaterThanOrEqual(59);
    expect(result.complete).toBe(true);
  });

  it("reports an unsplittable capped slice as incomplete", async () => {
    const { ctx, issues } = fakeCtx((_u, body) => ({ total: 2000, jobPostings: Array.from({ length: 20 }, (_, i) => row(obj(body).offset as number + i)), facets: [] }));
    const { result } = await drain(workday.list(src, ctx));
    expect(result.complete).toBe(false);
    expect(issues[0]?.code).toBe("pagination");
  });

  it("ignores the relative posted date in the fingerprint and maps detail", () => {
    const a = workday.fingerprint!({ title: "t", postedOn: "Posted Today" });
    expect(a).toEqual(workday.fingerprint!({ title: "t", postedOn: "Posted 3 Days Ago" }));
    const detail = fixture("workday-detail");
    const job = workday.map({ id: "/job/x/1", listing: list.jobPostings[0]!, detail }, src);
    expect(job).toMatchObject({ title: "Lead Warehouse Worker", requisitionId: "R0000476959", employmentType: "Full time", postedAt: "2026-10-23" });
    expect(job.locations[0]?.countryCode).toBe("US");
    expect(job.description).toContain("pay range");
  });
});
