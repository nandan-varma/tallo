import { prepareJob } from "@tallo/catalog";
import type { CollectContext, HttpResponse } from "@tallo/contracts";
import { jobFactsSchema } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { google, SchemaError } from "../src/index.ts";
import { drain, source, textFixture } from "./helpers.ts";

const src = source("google", "careers");

function pages(pages: Record<number, string>): {
  ctx: CollectContext;
  urls: string[];
} {
  const urls: string[] = [];
  const ctx: CollectContext = {
    http: {
      getJson: async () => {
        throw new Error("unexpected getJson");
      },
      postJson: async () => {
        throw new Error("unexpected postJson");
      },
      getText: async (url): Promise<HttpResponse<string>> => {
        urls.push(url);
        const page = Number(new URL(url).searchParams.get("page"));
        const data = pages[page];
        if (data === undefined) throw new Error(`unexpected page ${page}`);
        return { status: 200, url, data };
      },
    },
    maxPostings: 1000,
    record: () => {},
  };
  return { ctx, urls };
}

describe("google", () => {
  it("pages the whole board and keeps each positional row untouched", async () => {
    const { ctx, urls } = pages({
      1: textFixture("google-list-1.html"),
      2: textFixture("google-list-2.html"),
    });
    const { items, result } = await drain(google.list(src, ctx));
    expect(urls).toEqual([
      "https://www.google.com/about/careers/applications/jobs/results/?page=1",
      "https://www.google.com/about/careers/applications/jobs/results/?page=2",
    ]);
    expect(items.map((i) => i.id)).toEqual([
      "78511373281043142",
      "141234113599152838",
      "114623492665549510",
    ]);
    expect(Array.isArray(items[0]?.listing)).toBe(true);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("maps the positional record explicitly", async () => {
    const { ctx } = pages({
      1: textFixture("google-list-1.html"),
      2: textFixture("google-list-2.html"),
    });
    const { items } = await drain(google.list(src, ctx));
    const job = google.map(items[0]!, src);
    expect(job).toMatchObject({
      postingId: "78511373281043142",
      title: "Staff Machine Learning Engineer, YouTube Live Discovery",
      url: "https://www.google.com/about/careers/applications/jobs/results/78511373281043142",
      requisitionId: "78511373281043142",
    });
    expect(job.postedAt).toMatch(/^2026-11-/);
    expect(job.locations[0]).toMatchObject({
      text: "Mountain View, CA, USA",
      city: "Mountain View",
      region: "CA",
      countryCode: "US",
      primary: true,
    });
    expect(job.description).toContain("YouTube Live discovery");
    expect(job.description).toContain("Minimum qualifications");
    expect(job.extras).toMatchObject({ company: "YouTube", targetLevel: 3 });
    expect(job.compensation).toEqual([]);
    expect(job.experience).toEqual([]);
  });

  it("prepares a valid job fact row", async () => {
    const { ctx } = pages({
      1: textFixture("google-list-1.html"),
      2: textFixture("google-list-2.html"),
    });
    const { items } = await drain(google.list(src, ctx));
    const prepared = await prepareJob(google.map(items[0]!, src), src, "a".repeat(64));
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
  });

  it("reports an incomplete listing on a short non-final page", async () => {
    const { ctx } = pages({
      1: textFixture("google-list-1.html"),
      2: textFixture("google-list-2-short.html"),
    });
    const { result } = await drain(google.list(src, ctx));
    expect(result.complete).toBe(false);
  });

  it("reports an incomplete listing when the total moves mid-pagination", async () => {
    const { ctx } = pages({
      1: textFixture("google-list-1.html"),
      2: textFixture("google-list-2-moved.html"),
    });
    const { result } = await drain(google.list(src, ctx));
    expect(result.complete).toBe(false);
  });

  it("reports an incomplete listing when a page repeats", async () => {
    const { ctx } = pages({
      1: textFixture("google-list-1.html"),
      2: textFixture("google-list-1.html"),
    });
    const { result } = await drain(google.list(src, ctx));
    expect(result.complete).toBe(false);
  });

  it("throws SchemaError when the payload is missing or malformed", async () => {
    for (const fixture of ["google-no-ds.html", "google-bad-json.html"]) {
      const { ctx } = pages({ 1: textFixture(fixture) });
      await expect(drain(google.list(src, ctx))).rejects.toBeInstanceOf(SchemaError);
    }
  });

  it("accepts an authoritative empty board", async () => {
    const html =
      "<script>AF_initDataCallback({key: 'ds:1', data: [[], null, 0, 20], sideChannel: {}});</script>";
    const { ctx } = pages({ 1: html });
    const { items, result } = await drain(google.list(src, ctx));
    expect(items).toEqual([]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("rejects a malformed source key", () => {
    expect(() => google.validate(source("google", "../etc"))).toThrow(/Invalid google key/);
    expect(() => google.validate(source("google", "careers"))).not.toThrow();
  });
});
