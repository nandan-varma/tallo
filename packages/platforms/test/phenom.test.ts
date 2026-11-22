import { prepareJob } from "@tallo/catalog";
import type { Json } from "@tallo/contracts";
import { jobFactsSchema, obj } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { phenom, platformFor, SchemaError } from "../src/index.ts";
import { drain, fakeCtx, fixture, source, textCtx, textFixture } from "./helpers.ts";

const src = source("phenom", "www.jobs-ups.com");
const sha = "a".repeat(64);
const rows = (obj(obj(fixture("phenom-list")).refineSearch).data as { jobs: Json[] }).jobs;

/** A widget answering `total` rows of the recorded shape, honouring `from` and `size`. */
function widget(total: number) {
  return fakeCtx((_url, body) => {
    const { from, size } = obj(body) as { from: number; size: number };
    const jobs = Array.from({ length: Math.max(0, Math.min(size, total - from)) }, (_, i) => ({
      ...obj(rows[0]),
      jobId: `job-${from + i}`,
    }));
    return { refineSearch: { status: 200, hits: jobs.length, totalHits: total, data: { jobs } } };
  });
}

describe("phenom", () => {
  it("is registered and validates its key and locale params", () => {
    expect(platformFor(src).id).toBe("phenom");
    expect(() => platformFor(source("phenom", "example.com"))).toThrow(/jobs-ups/);
    expect(() => platformFor(source("phenom", "www.jobs-ups.com", { path: "../x" }))).toThrow(
      /path/,
    );
    expect(() => platformFor(source("phenom", "www.jobs-ups.com", { lang: "EN" }))).toThrow(/lang/);
  });

  it("pages the widget by 100 until totalHits and is complete", async () => {
    const { ctx, urls } = widget(250);
    const { items, result } = await drain(phenom.list(src, ctx));
    expect(items).toHaveLength(250);
    expect(urls).toEqual(Array(3).fill("https://www.jobs-ups.com/widgets"));
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("sends the search page's own request and keeps each row untouched", async () => {
    const bodies: Json[] = [];
    const { ctx } = fakeCtx((_url, body) => {
      bodies.push(body ?? null);
      return fixture("phenom-list");
    });
    const { items } = await drain(phenom.list(src, ctx));
    expect(bodies[0]).toMatchObject({
      ddoKey: "refineSearch",
      pageName: "search-results",
      lang: "en_us",
      country: "us",
      from: 0,
      size: 100,
    });
    expect(items.map((i) => i.id)).toEqual(["260d9feb-dfb0-4830-9da0-1346ba4e6f03", "R26042684"]);
    expect(items[0]?.listing).toEqual(rows[0]);
  });

  it("is incomplete when the budget stops it or the board is cut short", async () => {
    const budget = widget(250);
    budget.ctx.maxPostings = 5;
    const stopped = await drain(phenom.list(src, budget.ctx));
    expect(stopped.items).toHaveLength(5);
    expect(stopped.result.complete).toBe(false);
    expect(budget.issues[0]?.code).toBe("budget");

    // Claims 300 hits but the second page is empty: the listing is not the whole board.
    const short = fakeCtx((_url, body) => {
      const jobs = obj(body).from === 0 ? rows : [];
      return { refineSearch: { status: 200, hits: jobs.length, totalHits: 300, data: { jobs } } };
    });
    expect((await drain(phenom.list(src, short.ctx))).result.complete).toBe(false);
  });

  it("throws on an unexpected shape instead of returning an empty listing", async () => {
    await expect(drain(phenom.list(src, fakeCtx(() => ({ nope: 1 })).ctx))).rejects.toThrow(
      SchemaError,
    );
  });

  it("detail keeps only the public JSON-LD and reads the id's job page", async () => {
    const { ctx, urls } = textCtx(textFixture("phenom-corp-page.html"));
    const detail = await phenom.detail?.(src, { id: "R26042684", listing: rows[1] ?? null }, ctx);
    expect(urls).toEqual(["https://www.jobs-ups.com/us/en/job/R26042684"]);
    expect(Object.keys(obj(detail))).toEqual(["jsonLd"]);
    await expect(
      phenom.detail?.(src, { id: "x", listing: null }, textCtx("<html/>").ctx),
    ).rejects.toThrow(SchemaError);
  });

  it("turns a 410 page into a gone posting", async () => {
    const { ctx } = textCtx("");
    ctx.http.getText = async () => {
      throw Object.assign(new Error("410"), { status: 410 });
    };
    await expect(phenom.detail?.(src, { id: "R1", listing: null }, ctx)).rejects.toThrow(/gone/);
  });

  it("maps the hourly seasonal driver", async () => {
    const posting = { id: "260d9feb-dfb0-4830-9da0-1346ba4e6f03", listing: rows[0] ?? null };
    const detail = await phenom.detail?.(
      src,
      posting,
      textCtx(textFixture("phenom-driver-page.html")).ctx,
    );
    const job = phenom.map({ ...posting, detail }, src);
    expect(job).toMatchObject({
      postingId: posting.id,
      title: "Seasonal Support Driver",
      department: "Operations",
      employmentType: "PART_TIME",
      requisitionId: posting.id,
      postedAt: "2026-11-19T01:04:59.000+0000",
      compensation: [],
      extras: {
        openingPayRate: "$23.00/hour",
        contractType: "Temporary",
        schedule: "Part time",
        workHours: "24 hours per week",
      },
    });
    expect(job.url).toBe(`https://www.jobs-ups.com/us/en/job/${posting.id}`);
    expect(job.applyUrl).toContain("fountain.com/apply/ups");
    expect(job.locations[0]).toMatchObject({
      primary: true,
      city: "Seattle",
      region: "Washington",
    });
    expect(job.description).toMatch(/Seasonal Support Driver/);
    expect(job.description).not.toMatch(/&lt;|<p/);
    expect(jobFactsSchema.safeParse((await prepareJob(job, src, sha)).facts).success).toBe(true);
  });

  it("maps a corporate role with several places and no pay", async () => {
    const posting = { id: "R26042684", listing: rows[1] ?? null };
    const detail = await phenom.detail?.(
      src,
      posting,
      textCtx(textFixture("phenom-corp-page.html")).ctx,
    );
    const job = phenom.map({ ...posting, detail }, src);
    expect(job).toMatchObject({
      title: "Director, Software Engineering (Flex Location)",
      department: "Information Technology",
      employmentType: "FULL_TIME",
      requisitionId: "R26042684",
    });
    expect(job.applyUrl).toContain("myworkdayjobs.com");
    expect(job.locations).toHaveLength(3);
    expect(job.locations[1]?.city).toBeUndefined();
    expect(job.extras).not.toHaveProperty("openingPayRate");
  });

  it("fingerprints without the machine-derived fields", () => {
    const row = obj(rows[0]);
    const print = obj(phenom.fingerprint?.(row ?? null));
    expect(print).not.toHaveProperty("ml_skills");
    expect(print).not.toHaveProperty("ml_job_parser");
    expect(print.title).toBe("Seasonal Support Driver");
  });
});
