import { readFileSync } from "node:fs";
import type { CollectContext, Json, RawPosting } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { breezy, gem, pinpoint, rippling, SchemaError } from "../src/index.ts";
import { drain, fakeCtx, fixture, source } from "./helpers.ts";

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("rippling", () => {
  const src = source("rippling", "boom-supersonic");
  const list = fixture("rippling-list") as { items: Json[] };

  it("pages through the board and is complete when every posting was seen", async () => {
    const pages = [
      { ...list, page: 0, totalPages: 2, totalItems: 3 },
      {
        items: [{ ...(list.items[0] as object), id: "third" }],
        page: 1,
        totalPages: 2,
        totalItems: 3,
      },
    ];
    const { ctx, urls } = fakeCtx((url) => pages[Number(/page=(\d+)/.exec(url)?.[1])] as Json);
    const { items, result } = await drain(rippling.list(src, ctx));
    expect(urls).toEqual([
      "https://ats.rippling.com/api/v2/board/boom-supersonic/jobs?page=0&pageSize=500",
      "https://ats.rippling.com/api/v2/board/boom-supersonic/jobs?page=1&pageSize=500",
    ]);
    expect(items.map((i) => i.id)).toHaveLength(3);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("is complete when a posting open in several places repeats its id (totalItems counts rows)", async () => {
    const first = list.items[0] as object;
    const repeated = [first, first, list.items[1] as object];
    const { ctx } = fakeCtx(
      () => ({ items: repeated, page: 0, totalPages: 1, totalItems: 3 }) as Json,
    );
    const { items, result } = await drain(rippling.list(src, ctx));
    expect(items).toHaveLength(2);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("is incomplete when postings shifted between pages", async () => {
    const { ctx } = fakeCtx(() => ({ ...list, totalPages: 1, totalItems: 5 }) as Json);
    const { result } = await drain(rippling.list(src, ctx));
    expect(result.complete).toBe(false);
  });

  it("rejects an unexpected listing shape", async () => {
    const { ctx } = fakeCtx(() => ({ jobs: [] }));
    await expect(drain(rippling.list(src, ctx))).rejects.toThrow(SchemaError);
  });

  it("maps listing and detail, with pay only from the detail's stated bands", () => {
    const row = list.items[1] as Json;
    const detail = fixture("rippling-detail") as Record<string, Json>;
    const withPay = {
      ...detail,
      payRangeDetails: [
        {
          location: "US",
          currency: "USD",
          frequency: "YEAR",
          rangeStart: 185000,
          rangeEnd: 240000,
        },
      ],
    };
    const job = rippling.map({ id: "x", listing: row, detail: withPay }, src);
    expect(job.title).toBe("Build Engineer (Sign On Eligible)");
    expect(job.url).toContain("https://ats.rippling.com/boom-supersonic/jobs/");
    expect(job.description.length).toBeGreaterThan(50);
    expect(job.department).toBe("Build Engineering");
    expect(job.employmentType).toBe("Salaried, full-time");
    expect(job.workMode).toBe("onsite");
    expect(job.postedAt).toBe("2026-05-04T15:16:33.269000-07:00");
    expect(job.locations[0]).toMatchObject({
      city: "Centennial",
      countryCode: "US",
      primary: true,
    });
    expect(job.compensation).toEqual([
      {
        min: 185000,
        max: 240000,
        currency: "USD",
        interval: "year",
        component: "base",
        region: "US",
      },
    ]);
    expect(rippling.map({ id: "x", listing: row, detail }, src).compensation).toEqual([]);
  });

  it("fetches the posting endpoint for detail", async () => {
    const { ctx, urls } = fakeCtx(() => ({ uuid: "a" }));
    await rippling.detail?.(src, { id: "a b", listing: {} } satisfies RawPosting, ctx);
    expect(urls).toEqual(["https://ats.rippling.com/api/v1/board/boom-supersonic/jobs/a%20b"]);
  });
});

describe("gem", () => {
  const src = source("gem", "helm-health");

  it("lists every posting in one request", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("gem-list"));
    const { items, result } = await drain(gem.list(src, ctx));
    expect(urls).toEqual(["https://api.gem.com/job_board/v0/helm-health/job_posts/"]);
    expect(items).toHaveLength(2);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("rejects a non-array answer", async () => {
    const { ctx } = fakeCtx(() => ({ message: "nope" }));
    await expect(drain(gem.list(src, ctx))).rejects.toThrow(SchemaError);
  });

  it("maps the posting", () => {
    const [row] = fixture("gem-list") as Json[];
    const job = gem.map({ id: "x", listing: row as Json }, src);
    expect(job.title).toBe("Chief of Staff");
    expect(job.url).toMatch(/^https:\/\/jobs\.gem\.com\/helm-health\//);
    expect(job.workMode).toBe("remote");
    expect(job.employmentType).toBe("full_time");
    expect(job.description.length).toBeGreaterThan(50);
    expect(job.locations[0]).toMatchObject({ text: "United States - Remote", primary: true });
    expect(job.postedAt).toBeDefined();
    expect(job.compensation).toEqual([]);
  });
});

describe("pinpoint", () => {
  const src = source("pinpoint", "superiorgroup");

  it("lists every posting in one request", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("pinpoint-list"));
    const { items, result } = await drain(pinpoint.list(src, ctx));
    expect(urls).toEqual(["https://superiorgroup.pinpointhq.com/postings.json"]);
    expect(items).toHaveLength(2);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("accepts an empty board but rejects other shapes", async () => {
    const empty = fakeCtx(() => ({ data: [] }));
    expect((await drain(pinpoint.list(src, empty.ctx))).items).toEqual([]);
    const bad = fakeCtx(() => ({ postings: [] }));
    await expect(drain(pinpoint.list(src, bad.ctx))).rejects.toThrow(SchemaError);
  });

  it("maps the ad sections, pay and workplace", () => {
    const [row] = (fixture("pinpoint-list") as { data: Json[] }).data;
    const job = pinpoint.map({ id: "565960", listing: row as Json }, src);
    expect(job.title).toBe("Construction Safety Coordinator (Central Ohio)");
    expect(job.url).toBe(
      "https://superiorgroup.pinpointhq.com/en/postings/fbb8e1d3-52a6-4de4-8b41-fdce671a1ec1",
    );
    expect(job.workMode).toBe("onsite");
    expect(job.department).toBe("Safety");
    expect(job.description).toContain("Key Responsibilities");
    expect(job.compensation).toEqual([
      {
        min: 32,
        max: 46,
        currency: "USD",
        interval: "hour",
        component: "base",
        text: "$32.00 - $46.00 / hour",
      },
    ]);
  });

  it("leaves pay out when the employer hides it", () => {
    const [row] = (fixture("pinpoint-list") as { data: Record<string, Json>[] }).data;
    const job = pinpoint.map({ id: "1", listing: { ...row, compensation_visible: false } }, src);
    expect(job.compensation).toEqual([]);
  });
});

describe("breezy", () => {
  const src = source("breezy", "urrly");
  const feed = fixture("breezy-list") as Json[];

  function ctxFor(page: string): CollectContext & { urls: string[] } {
    const urls: string[] = [];
    const unused = async () => {
      throw new Error("unused");
    };
    return {
      http: {
        getJson: async (url) => {
          urls.push(url);
          return { status: 200, url, data: feed };
        },
        postJson: unused,
        getText: async (url) => {
          urls.push(url);
          return { status: 200, url, data: page };
        },
      },
      maxPostings: 1_000_000,
      record: () => {},
      urls,
    };
  }

  it("lists the feed, descriptions included, in one request", async () => {
    const ctx = ctxFor("");
    const { items, result } = await drain(breezy.list(src, ctx));
    expect(ctx.urls).toEqual(["https://urrly.breezy.hr/json?verbose=true"]);
    expect(items.map((i) => i.id)).toEqual(["36028fb8ea4f", "52a8d92b1010"]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("takes the description from the feed and pay from the job page's JSON-LD", async () => {
    const ctx = ctxFor(text("breezy-detail.html"));
    const listing = feed[0] as Json;
    const detail = await breezy.detail?.(src, { id: "36028fb8ea4f", listing }, ctx);
    expect(ctx.urls).toEqual([
      "https://urrly.breezy.hr/p/36028fb8ea4f-ai-automation-engineer-remote-u-s",
    ]);
    const job = breezy.map({ id: "36028fb8ea4f", listing, detail }, src);
    expect(job.title).toBe("AI Automation Engineer (Remote - U.S.)");
    expect(job.description).toContain("AI-native builder");
    expect(job.workMode).toBe("remote");
    expect(job.employmentType).toBe("Full-Time");
    expect(job.locations[0]).toMatchObject({
      city: "Beverly Hills",
      countryCode: "US",
      remote: true,
    });
    expect(job.compensation[0]).toMatchObject({
      min: 120000,
      max: 150000,
      currency: "USD",
      interval: "year",
      component: "base",
    });
  });

  it("fetches no job page for a posting whose feed row states no salary", async () => {
    const ctx = ctxFor(text("breezy-detail.html"));
    const listing = { ...(feed[1] as object), salary: "" } as Json;
    const detail = await breezy.detail?.(src, { id: "52a8d92b1010", listing }, ctx);
    expect(ctx.urls).toEqual([]);
    const job = breezy.map({ id: "52a8d92b1010", listing, detail }, src);
    expect(job.description).toContain("virtual assistant");
    expect(job.compensation).toEqual([]);
  });

  it("maps a listing without detail, and a job page without JSON-LD adds nothing", async () => {
    const listing = feed[0] as Json;
    const bare = breezy.map({ id: "36028fb8ea4f", listing }, src);
    expect(bare.description).toContain("AI-native builder");
    expect(bare.compensation).toEqual([]);
    const detail = await breezy.detail?.(
      src,
      { id: "36028fb8ea4f", listing },
      ctxFor("<html></html>"),
    );
    expect(breezy.map({ id: "36028fb8ea4f", listing, detail }, src).compensation).toEqual([]);
  });
});
