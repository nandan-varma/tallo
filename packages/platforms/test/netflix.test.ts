import { prepareJob } from "@tallo/catalog";
import type { Json } from "@tallo/contracts";
import { jobFactsSchema, obj } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { netflix, platformFor, SchemaError } from "../src/index.ts";
import { drain, fakeCtx, fixture, source } from "./helpers.ts";

const src = source("netflix", "netflix.com");
const list = obj(fixture("netflix-list"));
const rows = list.positions as Json[];

const page = (count: number, ids: number[]) => ({
  count,
  positions: ids.map((n) => ({ id: n, name: `Job ${n}` })),
});
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe("netflix", () => {
  it("lists the trimmed board through the public Eightfold job feed", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("netflix-list"));
    const { items, result } = await drain(netflix.list(src, ctx));
    expect(urls).toEqual([
      "https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&start=0&num=10",
    ]);
    expect(items.map((item) => item.id)).toEqual(["790298014263", "790319610169"]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("pages to the real end of a board whose count is larger than one page", async () => {
    const ids = range(1, 13);
    const { ctx, urls } = fakeCtx((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      return page(12, ids.slice(start, start + 10));
    });
    const { items, result } = await drain(netflix.list(src, ctx));
    expect(urls).toHaveLength(2);
    expect(items).toHaveLength(12);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("accepts a real empty board, which the API distinguishes from an unknown domain by 404", async () => {
    const { ctx } = fakeCtx(() => ({ count: 0, positions: [] }));
    const { items, result } = await drain(netflix.list(src, ctx));
    expect(items).toEqual([]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("fetches the description from the public job endpoint", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("netflix-detail-onsite"));
    const detail = await netflix.detail!(src, { id: "790298014263", listing: rows[0]! }, ctx);
    expect(urls).toEqual([
      "https://explore.jobs.netflix.net/api/apply/v2/jobs/790298014263?domain=netflix.com",
    ]);
    expect(obj(detail).job_description).toContain("At Netflix, our mission");
  });

  it("maps the onsite job and states only structured facts", async () => {
    const job = netflix.map(
      { id: "790298014263", listing: rows[0]!, detail: fixture("netflix-detail-onsite") },
      src,
    );
    expect(job).toMatchObject({
      postingId: "790298014263",
      title: "AI Engineer 6 - AI Foundation & Tooling, Ads Platform",
      url: "https://explore.jobs.netflix.net/careers/job/790298014263?microsite=netflix.com",
      applyUrl: "https://explore.jobs.netflix.net/careers/job/790298014263?microsite=netflix.com",
      workMode: "onsite",
      department: "Data & Insights",
      requisitionId: "AJRT30201",
      postedAt: "2026-10-19T00:00:00.000Z",
      compensation: [],
      experience: [],
    });
    expect(job.description).toContain("At Netflix, our mission");
    expect(job.locations[0]).toMatchObject({
      text: "Los Gatos,California,United States of America",
      primary: true,
    });
    expect(job.extras).toMatchObject({
      businessUnit: "Streaming",
      sourceType: "ATS",
      customFields: { job_req_id: ["AJRT30201"], team: ["Data & Insights"] },
    });
    const prepared = await prepareJob(job, src, "a".repeat(64));
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
  });

  it("maps a remote role from the listing's remote_local value and the detail's Work Type", async () => {
    const job = netflix.map(
      { id: "790319610169", listing: rows[1]!, detail: fixture("netflix-detail-remote") },
      src,
    );
    expect(job.title).toBe("Software Engineer 5, AI Observability");
    expect(job.workMode).toBe("remote");
    expect(job.department).toBe("Data & Insights");
    expect(job.postedAt).toBe("2026-11-19T00:00:00.000Z");
    expect(job.locations[0]?.text).toBe("Remote, United States");
    expect(job.description).toContain("Netflix");
    const prepared = await prepareJob(job, src, "b".repeat(64));
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
  });

  it("maps a listing without detail, leaving the description unknown", async () => {
    const job = netflix.map({ id: "790319610169", listing: rows[1]! }, src);
    expect(job.description).toBe("");
    expect(job.workMode).toBe("remote");
    expect(job.postedAt).toBe("2026-11-19T00:00:00.000Z");
    expect(job.applyUrl).toBe("https://explore.jobs.netflix.net/careers/job/790319610169");
    const prepared = await prepareJob(job, src, "c".repeat(64));
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
  });

  it("falls back to t_create when the structured posting date is missing or invalid", () => {
    const detail = obj(fixture("netflix-detail-onsite"));
    const custom = obj(detail.custom_JD);
    obj(custom.data_fields).posting_date = [];
    expect(netflix.map({ id: "790298014263", listing: rows[0]!, detail }, src).postedAt).toBe(
      "2024-07-23T00:00:00.000Z",
    );
    obj(custom.data_fields).posting_date = ["not-a-date"];
    expect(netflix.map({ id: "790298014263", listing: rows[0]!, detail }, src).postedAt).toBe(
      "2024-07-23T00:00:00.000Z",
    );
  });

  it("never claims completeness for a repeated page", async () => {
    const { ctx } = fakeCtx(() => page(20, range(1, 11)));
    await expect(drain(netflix.list(src, ctx))).rejects.toThrow(/repeated posting 1/);
  });

  it("never claims completeness when a page stops short of the count", async () => {
    const { ctx } = fakeCtx((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      return start === 0 ? page(25, range(1, 11)) : page(25, []);
    });
    await expect(drain(netflix.list(src, ctx))).rejects.toThrow(/ended at 10 of 25/);
  });

  it("never claims completeness when the count moves during pagination", async () => {
    const { ctx } = fakeCtx((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      return start === 0 ? page(12, range(1, 11)) : page(13, range(11, 13));
    });
    await expect(drain(netflix.list(src, ctx))).rejects.toThrow(/count changed from 12 to 13/);
  });

  it("rejects malformed pages instead of treating them as an empty board", async () => {
    const bad: Json[] = [
      {},
      { count: 1 },
      { count: 1, positions: {} },
      { positions: [] },
      { count: -1, positions: [] },
      { count: 1.5, positions: [] },
      { count: 11, positions: range(1, 12).map((n) => ({ id: n })) },
      { count: 1, positions: [{ name: "no id" }] },
      { count: 1, positions: [{ id: "1/path" }] },
      { count: 0, positions: [{ id: 1 }] },
      { count: 5, positions: range(1, 7).map((n) => ({ id: n })) },
    ];
    for (const body of bad) {
      const { ctx } = fakeCtx(() => body);
      await expect(drain(netflix.list(src, ctx))).rejects.toBeInstanceOf(SchemaError);
    }
  });

  it("rejects a source key that is not Netflix's public domain", () => {
    expect(() => platformFor(source("netflix", "netflix.com.evil"))).toThrow(/Netflix source key/);
    expect(() => platformFor(source("netflix", "../netflix.com"))).toThrow(/Invalid/);
  });

  it("keeps the original listing untouched", async () => {
    const { ctx } = fakeCtx(() => fixture("netflix-list"));
    const { items } = await drain(netflix.list(src, ctx));
    expect(items[0]?.listing).toEqual(rows[0]);
    expect(obj(items[1]?.listing).business_unit).toBe("Streaming");
  });
});
