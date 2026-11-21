import { prepareJob } from "@tallo/catalog";
import type { CollectContext, Json, RawPosting } from "@tallo/contracts";
import { jobFactsSchema, obj } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { amazon, platformFor, SchemaError } from "../src/index.ts";
import { drain, fakeCtx, fixture, source } from "./helpers.ts";

const src = source("amazon", "amazon", { category: "Software Development" });
const listingJobs = (name: string): Json[] => obj(fixture(name)).jobs as Json[];

/** A synthetic listing row: only the fields `list` reads, so paging failures stay the only variable. */
const row = (n: number): Json => ({
  id_icims: String(1_000_000 + n),
  title: `Job ${n}`,
  job_path: `/en/jobs/${1_000_000 + n}/job-${n}`,
});

const page = (from: number, count: number, hits: number, rows = row): Json => ({
  error: null,
  hits,
  facets: {},
  content: { sidebar: {}, search_results: {} },
  jobs: Array.from({ length: count }, (_, i) => rows(from + i)),
});

const offsetOf = (url: string): number => Number(new URL(url).searchParams.get("offset"));

describe("amazon", () => {
  it("lists a page untouched and reads the structured category filter", async () => {
    const body = fixture("amazon-list");
    const { ctx, urls } = fakeCtx(() => ({ ...obj(body), hits: 2 }));
    const { items, result } = await drain(amazon.list(src, ctx));
    expect(urls).toEqual([
      "https://www.amazon.jobs/en/search.json?base_query=&sort=recent&result_limit=100&offset=0&category%5B%5D=Software+Development",
      "https://www.amazon.jobs/en/search.json?base_query=&sort=recent&result_limit=100&offset=0&category%5B%5D=Software+Development",
    ]);
    expect(items.map((i) => i.listing)).toEqual(listingJobs("amazon-list"));
    expect(items.map((i) => i.id)).toEqual(["10610733", "10610535"]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("follows offset through the reported total and stops on the final short page", async () => {
    const { ctx, urls } = fakeCtx((url) => {
      const offset = offsetOf(url);
      return page(offset, offset === 200 ? 50 : 100, 250);
    });
    const { items, result } = await drain(amazon.list(src, ctx));
    expect(urls.map(offsetOf)).toEqual([0, 100, 200, 0]);
    expect(items).toHaveLength(250);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("never claims completeness when an insert shifts the first page during the run", async () => {
    let firstPage = 0;
    const { ctx } = fakeCtx((url) => {
      const offset = offsetOf(url);
      if (offset !== 0) return page(offset, offset === 200 ? 50 : 100, 250);
      return page(firstPage++ === 0 ? 0 : 1, 100, 250);
    });
    const { result } = await drain(amazon.list(src, ctx));
    expect(result).toEqual({ complete: false, emptyIsAuthoritative: false });
  });

  it("never claims completeness when a page repeats already-seen postings", async () => {
    const { ctx, issues } = fakeCtx(() => page(0, 100, 250));
    const { items, result } = await drain(amazon.list(src, ctx));
    expect(items).toHaveLength(100);
    expect(result).toEqual({ complete: false, emptyIsAuthoritative: false });
    expect(issues.some((i) => i.code === "pagination")).toBe(true);
  });

  it("reports a short interior page as incomplete and keeps the rows it did see", async () => {
    const { ctx } = fakeCtx((url) => {
      const offset = offsetOf(url);
      return page(offset, offset === 0 ? 100 : offset === 100 ? 50 : 0, 250);
    });
    const { items, result } = await drain(amazon.list(src, ctx));
    expect(items).toHaveLength(150);
    expect(result).toEqual({ complete: false, emptyIsAuthoritative: false });
  });

  it("stops at the public 10,000-result cap without claiming the end", async () => {
    const { ctx, issues } = fakeCtx((url) => page(offsetOf(url), 100, 10_000));
    const { items, result } = await drain(amazon.list(src, ctx));
    expect(items).toHaveLength(10_000);
    expect(result).toEqual({ complete: false, emptyIsAuthoritative: false });
    expect(issues.some((i) => /cap/.test(i.message))).toBe(true);
  });

  it("stops at the context posting budget and reports an incomplete listing", async () => {
    const { ctx, issues } = fakeCtx(() => page(0, 100, 500));
    const budgeted: CollectContext = { ...ctx, maxPostings: 3 };
    const { items, result } = await drain(amazon.list(src, budgeted));
    expect(items).toHaveLength(3);
    expect(result).toEqual({ complete: false, emptyIsAuthoritative: false });
    expect(issues.some((i) => i.code === "budget")).toBe(true);
  });

  it("treats an empty answer as complete but not authoritative (a typo facet also answers empty)", async () => {
    const { ctx } = fakeCtx(() => page(0, 0, 0));
    const { items, result } = await drain(amazon.list(src, ctx));
    expect(items).toEqual([]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("throws on the source's error envelope, missing counts and malformed pages", async () => {
    for (const body of [
      { error: "Result limit cannot be greater than 100", hits: 0, jobs: null },
      { error: "Cannot return more than 10000 results at once", hits: 0, jobs: null },
      { error: null, jobs: [] },
      { error: null, hits: -1, jobs: [] },
      { error: null, hits: 1.5, jobs: [] },
      { error: null, hits: 10, jobs: null },
      { error: null, hits: 10, jobs: {} },
      "not an object",
    ]) {
      const { ctx } = fakeCtx(() => body as Json);
      await expect(drain(amazon.list(src, ctx))).rejects.toThrow(SchemaError);
    }
  });

  it("throws on rows without a usable id and on more rows than reported", async () => {
    for (const body of [
      { error: null, hits: 1, jobs: [{ title: "no id" }] },
      { error: null, hits: 1, jobs: [{ id_icims: "abc" }] },
      { error: null, hits: 1, jobs: [row(1), row(2)] },
      { error: null, hits: 101, jobs: Array.from({ length: 101 }, (_, i) => row(i)) },
    ]) {
      const { ctx } = fakeCtx(() => body as Json);
      await expect(drain(amazon.list(src, ctx))).rejects.toThrow(SchemaError);
    }
  });

  it("maps structured fields, locations, pay left unstated and the full description", async () => {
    const listing = listingJobs("amazon-list")[0] as RawPosting["listing"];
    const job = amazon.map({ id: "10610733", listing }, src);
    expect(job).toMatchObject({
      postingId: "10610733",
      title: "Embedded SDE II, Hardware Engineering Services",
      url: "https://www.amazon.jobs/en/jobs/10610733/embedded-sde-ii-hardware-engineering-services",
      applyUrl: "https://account.amazon.jobs/jobs/10610733/apply",
      department: "Software Development",
      team: "aws",
      employmentType: "full-time",
      requisitionId: "10610733",
      postedAt: "2026-11-20",
      workMode: "onsite",
      compensation: [],
      experience: [],
    });
    expect(job.locations).toEqual([
      {
        text: "US, CA, Cupertino",
        city: "Cupertino",
        region: "California",
        countryCode: "US",
        primary: true,
      },
    ]);
    expect(job.description).toContain("AWS Infrastructure Services");
    expect(job.description).not.toContain("<");
    expect(job.extras).toMatchObject({
      jobFamily: "Software Development",
      businessCategory: "aws",
      companyName: "Amazon Data Services, Inc.",
    });
  });

  it("keeps every structured location of a multi-place posting", () => {
    const listing = listingJobs("amazon-list")[1] as RawPosting["listing"];
    const job = amazon.map({ id: "10610535", listing }, src);
    expect(job.locations.map((l) => l.text)).toEqual([
      "US, TX, Austin",
      "US, CA, Sunnyvale",
      "US, WA, Redmond",
      "US, CA, Irvine",
      "US, CA, El Segundo",
      "US, CA, NORTHRIDGE",
    ]);
    expect(job.locations[0]).toMatchObject({ primary: true, countryCode: "US" });
    expect(job.workMode).toBe("onsite");
  });

  it("maps a recorded VIRTUAL location to remote", () => {
    const listing = listingJobs("amazon-virtual-list")[0] as RawPosting["listing"];
    const job = amazon.map({ id: "10607387", listing }, src);
    expect(job.workMode).toBe("remote");
    expect(job.locations).toEqual([
      {
        text: "US, Virtual",
        city: "Virtual",
        countryCode: "US",
        remote: true,
        primary: true,
      },
    ]);
  });

  it("leaves mixed location types unknown and rejects malformed location JSON", () => {
    const listing = listingJobs("amazon-list")[0] as RawPosting["listing"];
    const mixed = {
      ...obj(listing),
      locations: [
        '{"type":"ONSITE","location":"US, WA, Seattle"}',
        '{"type":"VIRTUAL","location":"US, Virtual"}',
      ],
    };
    expect(amazon.map({ id: "10610733", listing: mixed }, src).workMode).toBeUndefined();
    expect(() =>
      amazon.map({ id: "10610733", listing: { ...obj(listing), locations: ["not json"] } }, src),
    ).toThrow(SchemaError);
  });

  it("prepares a schema-valid job fact record", async () => {
    const listing = listingJobs("amazon-list")[0] as RawPosting["listing"];
    const prepared = await prepareJob(
      amazon.map({ id: "10610733", listing }, src),
      src,
      "a".repeat(64),
    );
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
    expect(prepared.facts.facts.compensation).toEqual([]);
  });

  it("drops only volatile listing fields from the fingerprint", () => {
    const listing = obj(listingJobs("amazon-list")[0]);
    const stable = amazon.fingerprint?.(listing) as Record<string, Json>;
    expect(stable.title).toBe(listing.title);
    expect(stable).not.toHaveProperty("updated_time");
    expect(stable).not.toHaveProperty("display_distance");
  });

  it("validates the source key and the category label", () => {
    expect(() => platformFor(source("amazon", "Amazon", {}))).toThrow(/Invalid/);
    expect(() => platformFor(source("amazon", "amazon", { category: "" }))).toThrow(/category/);
    expect(() => platformFor(source("amazon", "amazon", { category: "bad\u0000label" }))).toThrow(
      /category/,
    );
    expect(() =>
      platformFor(source("amazon", "amazon", { category: "Software Development" })),
    ).not.toThrow();
  });
});
