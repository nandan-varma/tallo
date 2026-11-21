import { readFileSync } from "node:fs";
import type { CollectContext, RawPosting } from "@tallo/contracts";
import { obj } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { personio, SchemaError } from "../src/index.ts";
import { drain, source } from "./helpers.ts";

const src = source("personio", "personio");
const xml = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), "utf8");

/** Fake Http serving text bodies (the shared fake only serves JSON). */
function textCtx(handler: (url: string) => string) {
  const urls: string[] = [];
  const unused = async () => {
    throw new Error("unused");
  };
  const ctx: CollectContext = {
    http: {
      getJson: unused,
      postJson: unused,
      getText: async (url) => {
        urls.push(url);
        return { status: 200, url, data: handler(url) };
      },
    },
    maxPostings: 1_000_000,
    record: () => {},
  };
  return { ctx, urls };
}

describe("personio", () => {
  it("lists the feed in one request and is never authoritatively empty", async () => {
    const { ctx, urls } = textCtx(() => xml("personio-list"));
    const { items, result } = await drain(personio.list(src, ctx));
    expect(urls).toEqual(["https://personio.jobs.personio.de/xml"]);
    expect(items.map((i) => i.id)).toEqual(["2885178", "2884392"]);
    expect(obj(items[0]?.listing).name).toBe("Business Development Representative (d/f/m)");
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("lists an empty feed as empty but rejects other shapes", async () => {
    const empty = textCtx(() => "<?xml version='1.0'?><workzag-jobs>\n</workzag-jobs>");
    expect((await drain(personio.list(src, empty.ctx))).items).toEqual([]);
    for (const body of [
      "<html><body>Not found</body></html>",
      "<workzag-jobs><position/></workzag-jobs>",
    ])
      await expect(drain(personio.list(src, textCtx(() => body).ctx))).rejects.toThrow(SchemaError);
  });

  it("reads the English feed once for postings without a default-language description", async () => {
    const { ctx, urls } = textCtx((url) =>
      xml(url.endsWith("language=en") ? "personio-detail-en" : "personio-list"),
    );
    const { items } = await drain(personio.list(src, ctx));
    const first = items[0] as RawPosting;
    const detail = await personio.detail?.(src, first, ctx);
    await personio.detail?.(src, items[1] as RawPosting, ctx);
    expect(urls.filter((u) => u.endsWith("language=en"))).toHaveLength(1);
    const job = personio.map({ ...first, detail }, src);
    expect(job).toMatchObject({
      postingId: "2885178",
      title: "Business Development Representative (d/f/m)",
      url: "https://personio.jobs.personio.de/job/2885178",
      department: "Go to Market",
      employmentType: "permanent",
      postedAt: "2026-11-11T17:43:42+00:00",
      compensation: [],
      extras: { seniority: "entry-level", schedule: "full-time" },
    });
    expect(job.description).toContain("3 days per week in the office");
    expect(job.locations.map((l) => l.text)).toEqual(["Berlin"]);
  });

  it("maps additional offices and the experience band; skips detail when described", async () => {
    const { ctx, urls } = textCtx(() => xml("personio-offices"));
    const dci = source("personio", "dci");
    const { items } = await drain(personio.list(dci, ctx));
    const job = personio.map(items[0] as RawPosting, dci);
    expect(job.locations.map((l) => l.text)).toEqual(["deutschlandweit/germany-wide", "Köln"]);
    expect(job.experience).toEqual([
      { min: 2, max: 5, unit: "years", kind: "stated", text: "2-5" },
    ]);
    const described: RawPosting = { id: "1", listing: { jobDescriptions: "<x/>" } };
    expect(await personio.detail?.(dci, described, ctx)).toEqual({});
    expect(urls).toHaveLength(1);
  });

  it("maps structured salary information and leaves an unstated interval unknown", async () => {
    const { ctx } = textCtx(() => xml("personio-salary"));
    const { items } = await drain(personio.list(src, ctx));
    const job = personio.map(items[0] as RawPosting, src);
    expect(job.compensation).toEqual([
      { min: 73022, max: 82950, currency: "GBP", interval: "year", component: "base" },
    ]);
    const odd = personio.map(
      { id: "1", listing: { salaryInformation: { min: "10.00", currencyCode: "EUR", type: "x" } } },
      src,
    );
    expect(odd.compensation[0]).toMatchObject({ min: 10, interval: "unknown" });
  });

  it("rejects a truncated XML feed rather than accepting a partial listing", async () => {
    const body = "<workzag-jobs><position><id>1</id><name>Engineer</name></position>";
    await expect(drain(personio.list(src, textCtx(() => body).ctx))).rejects.toThrow(SchemaError);
  });

  it("keeps source section names as literal text", () => {
    const job = personio.map(
      {
        id: "1",
        listing: {
          name: "Engineer",
          jobDescriptions: {
            jobDescription: [
              { name: "Benefits <em>and</em> growth & learning", value: "<p>Work with us.</p>" },
            ],
          },
        },
      },
      src,
    );
    expect(job.description).toContain("Benefits <em>and</em> growth & learning");
  });

  it("bounds total XML entity expansion across the response", async () => {
    const positions = Array.from(
      { length: 1001 },
      (_, i) => `<position><id>${i}</id><name>${"&x;".repeat(101)}</name></position>`,
    ).join("");
    const body = `<!DOCTYPE workzag-jobs [<!ENTITY x "x">]><workzag-jobs>${positions}</workzag-jobs>`;
    await expect(drain(personio.list(src, textCtx(() => body).ctx))).rejects.toThrow(SchemaError);
  });

  it("validates keys", () => {
    expect(() => personio.validate(source("personio", "a/b"))).toThrow(/Invalid/);
    expect(() => personio.validate(source("personio", "peter-park"))).not.toThrow();
  });
});
