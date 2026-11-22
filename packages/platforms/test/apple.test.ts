import { prepareJob } from "@tallo/catalog";
import type { CollectContext, HttpResponse, Json, JsonObject } from "@tallo/contracts";
import { jobFactsSchema, obj } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { apple, SchemaError } from "../src/index.ts";
import { drain, fixture, source } from "./helpers.ts";

const src = source("apple", "careers");

function search(handler: (page: number) => Json): {
  ctx: CollectContext;
  pages: number[];
} {
  const pages: number[] = [];
  const ctx: CollectContext = {
    http: {
      getJson: async (url): Promise<HttpResponse> => ({ status: 200, url, data: {} }),
      postJson: async (url, body): Promise<HttpResponse> => {
        const page = Number(obj(body).page);
        pages.push(page);
        return { status: 200, url, data: handler(page) };
      },
      getText: async () => {
        throw new Error("unexpected getText");
      },
    },
    maxPostings: 1000,
    record: () => {},
  };
  return { ctx, pages };
}

const row = (offset: number): JsonObject => {
  const base = obj(fixture("apple-list")).res;
  const first = obj(obj(base).searchResults);
  return {
    ...obj(first),
    id: `PIPE-${900000 + offset}`,
    positionId: String(900000 + offset),
    reqId: `PIPE-${900000 + offset}`,
    postingTitle: `Software Engineer ${offset}`,
    transformedPostingTitle: `software-engineer-${offset}`,
  };
};

const page = (rows: JsonObject[], total: number): Json => ({
  res: {
    searchResults: rows,
    totalRecords: total,
    talentLimitDetails: {},
    talentRolesInfoById: {},
  },
});

describe("apple", () => {
  it("pages the fixed board and keeps each search row untouched", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i));
    const { ctx, pages } = search((p) =>
      p === 1 ? page(rows, 21) : p === 2 ? page([row(20)], 21) : page([], 21),
    );
    const { items, result } = await drain(apple.list(src, ctx));
    expect(pages).toEqual([1, 2]);
    expect(items).toHaveLength(21);
    expect(items[0]?.id).toBe("PIPE-900000");
    expect(obj(items[0]!.listing).postingTitle).toBe("Software Engineer 0");
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("maps the full detail and the canonical public URL", async () => {
    const detail = obj(fixture("apple-detail")).res;
    const job = apple.map({ id: "200696388-0836", listing: {}, detail }, src);
    expect(job).toMatchObject({
      postingId: "200696388-0836",
      title: "iPhone Analog Design Engineer",
      url: "https://jobs.apple.com/en-us/details/200696388-0836/iphone-analog-design-engineer",
      requisitionId: "200696388-0836",
      department: "Hardware",
      employmentType: "Standard",
      postedAt: "2026-11-21",
    });
    expect(job.locations[0]).toMatchObject({
      text: "Cupertino, California, United States",
      city: "Cupertino",
      region: "California",
      countryCode: "US",
      primary: true,
    });
    expect(job.description).toContain("Analog Design Engineer");
    expect(job.description).toContain("Minimum qualifications");
    expect(job.description).toContain("Pay & Benefits");
    // The pay range is prose in a footer; it is not parsed into a typed band.
    expect(job.compensation).toEqual([]);
    expect(job.experience).toEqual([]);
    expect(job.extras).toMatchObject({ teams: ["Hardware"], type: "REQ", homeOffice: false });
  });

  it("keeps a search row's weekly hours when the detail does not state them", () => {
    const detailBody = obj(obj(fixture("apple-detail")).res);
    const withoutHours = { ...detailBody, standardWeeklyHours: null };
    const fromRow = apple.map(
      { id: "1", listing: { standardWeeklyHours: 35 }, detail: withoutHours },
      src,
    );
    expect(fromRow.extras).toMatchObject({ standardWeeklyHours: 35 });
    // The detail's value stays the reading when both states one.
    const both = apple.map(
      { id: "1", listing: { standardWeeklyHours: 35 }, detail: detailBody },
      src,
    );
    expect(both.extras).toMatchObject({ standardWeeklyHours: 40 });
  });

  it("maps a pipeline role whose public path uses the position id", async () => {
    const listing = obj(obj(fixture("apple-list")).res).searchResults;
    const first = obj(Array.isArray(listing) ? listing[0] : null);
    const detail = obj(fixture("apple-detail-pipe")).res;
    const job = apple.map({ id: "PIPE-114438210", listing: first, detail }, src);
    expect(job.url).toBe("https://jobs.apple.com/en-us/details/114438210/jp-technical-specialist");
    expect(job.locations[0]).toMatchObject({ text: "Japan", countryCode: "JP", primary: true });
    expect(job.workMode).toBeUndefined();
    expect(job.department).toBe("Apple Retail");
  });

  it("fingerprints a search row without its request-time post date", () => {
    const first = row(0);
    const later = { ...first, postDateInGMT: "2030-01-01T00:00:00.000000000Z" };
    expect(first.postDateInGMT).not.toBe(later.postDateInGMT);
    expect(apple.fingerprint?.(later)).toEqual(apple.fingerprint?.(first));
    expect(apple.fingerprint?.({ ...first, postingTitle: "Renamed" })).not.toEqual(
      apple.fingerprint?.(first),
    );
  });

  it("prepares a valid job fact row", async () => {
    const detail = obj(fixture("apple-detail")).res;
    const job = apple.map({ id: "200696388-0836", listing: {}, detail }, src);
    const prepared = await prepareJob(job, src, "a".repeat(64));
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
  });

  it("reports an incomplete listing on a short non-final page", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i));
    const { ctx } = search((p) =>
      p === 1 ? page(rows, 41) : p === 2 ? page([row(20)], 41) : page([], 41),
    );
    const { result } = await drain(apple.list(src, ctx));
    expect(result.complete).toBe(false);
  });

  it("reports an incomplete listing when a page repeats", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i));
    const { ctx } = search((p) => (p === 1 ? page(rows, 41) : page(rows, 41)));
    const { result } = await drain(apple.list(src, ctx));
    expect(result.complete).toBe(false);
  });

  it("reports an incomplete listing when the total moves mid-pagination", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i));
    const { ctx } = search((p) =>
      p === 1 ? page(rows, 21) : p === 2 ? page([row(20)], 22) : page([], 22),
    );
    const { result } = await drain(apple.list(src, ctx));
    expect(result.complete).toBe(false);
  });

  it("accepts an authoritative empty board", async () => {
    const { ctx } = search(() => page([], 0));
    const { items, result } = await drain(apple.list(src, ctx));
    expect(items).toEqual([]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("throws SchemaError on malformed search responses", async () => {
    for (const bad of [
      {},
      { res: {} },
      { res: { searchResults: [], totalRecords: "x" } },
    ] as Json[]) {
      const { ctx } = search(() => bad);
      await expect(drain(apple.list(src, ctx))).rejects.toBeInstanceOf(SchemaError);
    }
  });

  it("rejects a malformed source key", () => {
    expect(() => apple.validate(source("apple", "../etc"))).toThrow(/Invalid apple key/);
    expect(() => apple.validate(source("apple", "careers"))).not.toThrow();
  });
});
