import { prepareJob } from "@tallo/catalog";
import type { Http, Issue, Json, RawPosting } from "@tallo/contracts";
import { arr, jobFactsSchema, obj } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { goldman, ibm, microsoft, platformFor, SchemaError, starbucks } from "../src/index.ts";
import { PostingGone } from "../src/kit.ts";
import { drain, fakeCtx, fixture, source } from "./helpers.ts";

const sha = "a".repeat(64);

describe("ibm", () => {
  const src = source("ibm", "ibm");
  const hits = (name = "ibm-list"): Json[] => arr(obj(obj(fixture(name)).hits).hits);
  const hit = (n: number): Json => ({
    _id: `id${n}`,
    _source: { title: `Job ${n}`, field_text_01: 1000 + n },
  });
  const page = (from: number, count: number, total: number, relation = "eq"): Json => ({
    hits: {
      total: { value: total, relation },
      hits: Array.from({ length: count }, (_, i) => hit(from + i)),
    },
  });
  const fromOf = (body?: Json): number => Number(obj(body).from);

  it("lists the trimmed fixture with one search request and reads the whole index", async () => {
    const { ctx, urls } = fakeCtx(() => ({
      hits: { total: { value: 2, relation: "eq" }, hits: hits() },
    }));
    const { items, result } = await drain(ibm.list(src, ctx));
    expect(urls).toEqual(["https://www-api.ibm.com/search/api/v2"]);
    expect(items.map((i) => i.listing)).toEqual(hits());
    expect(items).toHaveLength(2);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("pages by offset through the reported total", async () => {
    const { ctx } = fakeCtx((_url, body) => {
      const from = fromOf(body);
      return page(from, from === 200 ? 50 : 100, 250);
    });
    const { items, result } = await drain(ibm.list(src, ctx));
    expect(items).toHaveLength(250);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("sends a stable sort and the field whitelist", async () => {
    const bodies: Json[] = [];
    const { ctx } = fakeCtx((_url, body) => {
      bodies.push(body ?? null);
      return page(0, 1, 1);
    });
    await drain(ibm.list(src, ctx));
    const sent = obj(bodies[0]);
    expect(sent.sort).toEqual([{ dcdate: "desc" }, { _id: "asc" }]);
    expect(sent.size).toBe(100);
    expect(arr(sent._source)).toContain("body");
  });

  it("is incomplete when the total moves, a page repeats, or the window ends", async () => {
    const moved = fakeCtx((_url, body) => page(fromOf(body), 100, fromOf(body) === 0 ? 200 : 201));
    expect((await drain(ibm.list(src, moved.ctx))).result.complete).toBe(false);

    const repeat = fakeCtx(() => page(0, 100, 200));
    const r = await drain(ibm.list(src, repeat.ctx));
    expect(r.items).toHaveLength(100);
    expect(r.result.complete).toBe(false);

    const big = fakeCtx((_url, body) => page(fromOf(body), 100, 12_000));
    const w = await drain(ibm.list(src, big.ctx));
    expect(w.items).toHaveLength(10_000);
    expect(w.result.complete).toBe(false);
  });

  it("stops at the posting budget", async () => {
    const { ctx, issues } = fakeCtx(() => page(0, 100, 500));
    const r = await drain(ibm.list(src, { ...ctx, maxPostings: 3 }));
    expect(r.items).toHaveLength(3);
    expect(r.result.complete).toBe(false);
    expect(issues.some((i) => i.code === "budget")).toBe(true);
  });

  it("throws on malformed answers and on hits without a requisition number", async () => {
    for (const body of [
      "nope",
      { hits: {} },
      { hits: { total: { value: 1, relation: "gte" }, hits: [hit(1)] } },
      { hits: { total: { value: 1, relation: "eq" }, hits: "x" } },
      { hits: { total: { value: 1, relation: "eq" }, hits: [{ _source: { title: "x" } }] } },
    ]) {
      const { ctx } = fakeCtx(() => body as Json);
      await expect(drain(ibm.list(src, ctx))).rejects.toThrow(SchemaError);
    }
  });

  it("an empty answer is complete but never authoritative", async () => {
    const { ctx } = fakeCtx(() => page(0, 0, 0));
    expect((await drain(ibm.list(src, ctx))).result).toEqual({
      complete: true,
      emptyIsAuthoritative: false,
    });
  });

  it("maps stated fields and leaves pay and posting date unstated", async () => {
    const listing = hits()[0] as RawPosting["listing"];
    const job = ibm.map({ id: "x", listing }, src);
    const s = obj(obj(listing)._source);
    expect(job.title).toBe(s.title);
    expect(job.url).toBe(s.url);
    expect(job.applyUrl).toBe(s.url);
    expect(job.compensation).toEqual([]);
    expect(job.postedAt).toBeUndefined();
    expect(job.requisitionId).toBe("x");
    expect(job.description.length).toBeGreaterThan(100);
    expect(job.locations[0]).toMatchObject({ primary: true, country: s.field_keyword_05 });
    expect(job.extras.indexedDate).toBe(s.dcdate);
    const prepared = await prepareJob(job, src, sha);
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
  });

  it("fingerprints only the stored source fields", () => {
    const row = obj(hits()[0]);
    const a = ibm.fingerprint?.({ ...row, _index: "one", sort: [1], _score: 1 });
    const b = ibm.fingerprint?.({ ...row, _index: "two", sort: [2], _score: 2 });
    expect(a).toEqual(b);
    expect(a).toEqual(row._source);
  });

  it("validates the source key", () => {
    expect(() => platformFor(source("ibm", "other"))).toThrow(/ibm/);
    expect(() => platformFor(src)).not.toThrow();
  });
});

describe("goldman", () => {
  const src = source("goldman", "goldmansachs");
  const items = (): Json[] => arr(obj(obj(obj(fixture("goldman-list")).data).roleSearch).items);
  const role = (n: number): Json => ({
    roleId: `${n}_GS`,
    jobTitle: `Role ${n}`,
    externalSource: { sourceId: String(n) },
  });
  const answer = (from: number, count: number, total: number, hasNext: boolean): Json => ({
    data: {
      roleSearch: {
        page: { pageSize: 250, pageNumber: 0, hasNext },
        totalCount: total,
        items: Array.from({ length: count }, (_, i) => role(from + i + 1)),
      },
    },
  });
  const pageOf = (body?: Json): number =>
    Number(obj(obj(obj(obj(body).variables).searchQueryInput).page).pageNumber);

  it("lists the fixture rows untouched through the GraphQL gateway", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("goldman-list"));
    const { items: got, result } = await drain(goldman.list(src, ctx));
    // The fixture states hasNext, so a second request is made; it repeats the rows and ends the listing.
    expect(urls).toEqual(Array(2).fill("https://api-higher.gs.com/gateway/api/v1/graphql"));
    expect(got.map((i) => i.listing)).toEqual(items());
    expect(got.map((i) => i.id)).toEqual(["187448", "178893", "187295"]);
    expect(result.complete).toBe(false);
  });

  it("pages until hasNext is false and reports a complete listing", async () => {
    const { ctx } = fakeCtx((_url, body) => {
      const n = pageOf(body);
      return answer(n * 250, n === 2 ? 100 : 250, 600, n < 2);
    });
    const { items: got, result } = await drain(goldman.list(src, ctx));
    expect(got).toHaveLength(600);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("requests the public experience groups sorted newest first", async () => {
    const bodies: Json[] = [];
    const { ctx } = fakeCtx((_url, body) => {
      bodies.push(body ?? null);
      return answer(0, 1, 1, false);
    });
    await drain(goldman.list(src, ctx));
    const input = obj(obj(obj(bodies[0]).variables).searchQueryInput);
    expect(input.experiences).toEqual(["PROFESSIONAL", "EARLY_CAREER", "CAMPUS"]);
    expect(input.sort).toEqual({ sortStrategy: "POSTED_DATE", sortOrder: "DESC" });
  });

  it("is incomplete when rows repeat or the total moves, and an empty board is authoritative", async () => {
    const repeat = fakeCtx((_url, body) => answer(0, 250, 500, pageOf(body) === 0));
    const r = await drain(goldman.list(src, repeat.ctx));
    expect(r.result.complete).toBe(false);

    const empty = fakeCtx(() => answer(0, 0, 0, false));
    expect((await drain(goldman.list(src, empty.ctx))).result).toEqual({
      complete: true,
      emptyIsAuthoritative: true,
    });
  });

  it("throws on GraphQL errors and malformed answers", async () => {
    for (const body of [
      { errors: [{ message: "Validation Exception." }], data: null },
      { data: { roleSearch: { totalCount: 1, page: { hasNext: false } } } },
      { data: { roleSearch: { totalCount: null, page: { hasNext: false }, items: [] } } },
      { data: { roleSearch: { totalCount: 1, page: {}, items: [] } } },
      {
        data: {
          roleSearch: { totalCount: 1, page: { hasNext: false }, items: [{ roleId: "x" }] },
        },
      },
      "nope",
    ]) {
      const { ctx } = fakeCtx(() => body as Json);
      await expect(drain(goldman.list(src, ctx))).rejects.toThrow(SchemaError);
    }
  });

  it("maps description, department, pay without an invented interval and the role page", async () => {
    const listing = items()[2] as RawPosting["listing"];
    const job = goldman.map({ id: "187295", listing }, src);
    expect(job.url).toBe("https://higher.gs.com/roles/187295");
    expect(job.applyUrl).toBe(job.url);
    expect(job.description.length).toBeGreaterThan(50);
    expect(job.description).not.toMatch(/<p>/);
    expect(job.department).toBe(obj(listing).division);
    expect(job.requisitionId).toBe("187295");
    expect(job.locations[0]).toMatchObject({ primary: true, countryCode: "US" });
    const withPay = goldman.map(
      {
        id: "1",
        listing: {
          jobTitle: "x",
          compensation: { minSalary: 100, maxSalary: 200, currency: "USD" },
        },
      },
      src,
    );
    expect(withPay.compensation).toEqual([
      { min: 100, max: 200, currency: "USD", interval: "unknown", component: "base" },
    ]);
    const prepared = await prepareJob(job, src, sha);
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
  });

  it("drops only the gateway's refresh stamp from the fingerprint", () => {
    const row = obj(items()[0]);
    const a = goldman.fingerprint?.({ ...row, createdDate: "2026-01-01T00:00:00Z" });
    const b = goldman.fingerprint?.({ ...row, createdDate: "2026-02-02T00:00:00Z" });
    expect(a).toEqual(b);
    expect(obj(a).jobTitle).toBe(row.jobTitle);
  });

  it("validates the source key", () => {
    expect(() => platformFor(source("goldman", "x"))).toThrow(/goldmansachs/);
    expect(() => platformFor(src)).not.toThrow();
  });
});

describe("microsoft", () => {
  const src = source("microsoft", "microsoft.com");
  const rowsOf = (): Json[] => arr(obj(obj(fixture("microsoft-list")).data).positions);
  const sitemap = (...entries: { id: string; lastmod?: string }[]): string =>
    `<?xml version="1.0"?><urlset><url><loc>https://apply.careers.microsoft.com/careers?domain=microsoft.com</loc></url>${entries
      .map(
        (e) =>
          `<url><loc>https://apply.careers.microsoft.com/careers/job/${e.id}-a-title-redmond?domain=microsoft.com</loc>${
            e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""
          }</url>`,
      )
      .join("")}</urlset>`;
  /** Fake Http: the sitemap by `getText`, the one search call (for its total) by `getJson`. */
  const siteCtx = (xml: string, search: () => Json) => {
    const urls: string[] = [];
    const http: Http = {
      getText: async (url) => {
        urls.push(url);
        return { status: 200, url, data: xml };
      },
      getJson: async (url) => {
        urls.push(url);
        return { status: 200, url, data: search() };
      },
      postJson: async () => {
        throw new Error("unexpected postJson");
      },
    };
    const issues: Issue[] = [];
    return {
      ctx: { http, maxPostings: 1_000_000, record: (i: Issue) => void issues.push(i) },
      urls,
      issues,
    };
  };
  const total = (count: number): Json => ({ status: 200, data: { count, positions: [] } });

  it("lists the sitemap's postings with their lastmod and reads the total once", async () => {
    const { ctx, urls } = siteCtx(
      sitemap(
        { id: "1970393557071956", lastmod: "2026-11-25T00:00:00Z" },
        { id: "1970393557040981" },
      ),
      () => total(2),
    );
    const { items, result } = await drain(microsoft.list(src, ctx));
    expect(urls).toEqual([
      "https://apply.careers.microsoft.com/careers/sitemap.xml?domain=microsoft.com",
      "https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=&location=&start=0&sort_by=timestamp",
    ]);
    expect(items.map((i) => i.id)).toEqual(["1970393557071956", "1970393557040981"]);
    expect(items[0]?.listing).toEqual({ id: "1970393557071956", lastmod: "2026-11-25T00:00:00Z" });
    expect(items[1]?.listing).toEqual({ id: "1970393557040981" });
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("lists a posting once, and skips the site's home url", async () => {
    const { ctx } = siteCtx(sitemap({ id: "11" }, { id: "11" }, { id: "12" }), () => total(2));
    const { items } = await drain(microsoft.list(src, ctx));
    expect(items.map((i) => i.id)).toEqual(["11", "12"]);
  });

  it("is incomplete when the sitemap and the reported total disagree by more than a few", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => ({ id: String(100 + i) }));
    const short = siteCtx(sitemap(...ids), () => total(100));
    const r = await drain(microsoft.list(src, short.ctx));
    expect(r.result.complete).toBe(false);
    expect(short.issues[0]?.code).toBe("pagination");
    // A difference of a few is two reads a moment apart, not a missing page.
    const near = siteCtx(sitemap(...ids), () => total(43));
    expect((await drain(microsoft.list(src, near.ctx))).result.complete).toBe(true);
  });

  it("is incomplete, never failed, when the total cannot be read", async () => {
    for (const search of [
      () => {
        throw new Error("Request failed with status code 429");
      },
      () => ({ status: 200, data: { positions: [] } }),
    ]) {
      const { ctx, issues } = siteCtx(sitemap({ id: "21" }), search as () => Json);
      const r = await drain(microsoft.list(src, ctx));
      expect(r.items).toHaveLength(1);
      expect(r.result.complete).toBe(false);
      expect(issues[0]?.message).toMatch(/total/);
    }
  });

  it("throws on a sitemap that is not a urlset or lists no postings", async () => {
    for (const xml of ["Please try again later", "<html></html>", sitemap()]) {
      const { ctx } = siteCtx(xml, () => total(0));
      await expect(drain(microsoft.list(src, ctx))).rejects.toThrow(SchemaError);
    }
  });

  it("treats a 404 from position_details as a gone posting", async () => {
    const http: Http = {
      getText: async () => {
        throw new Error("unexpected getText");
      },
      getJson: async () => {
        throw Object.assign(new Error("Request failed with status code 404"), { status: 404 });
      },
      postJson: async () => {
        throw new Error("unexpected postJson");
      },
    };
    await expect(
      microsoft.detail?.(
        src,
        { id: "7", listing: { id: "7" } },
        { http, maxPostings: 10, record: () => {} },
      ),
    ).rejects.toBeInstanceOf(PostingGone);
  });

  it("fingerprints a posting by its lastmod only", () => {
    const a = microsoft.fingerprint?.({ id: "1", lastmod: "2026-11-25T00:00:00Z" });
    const b = microsoft.fingerprint?.({ id: "1", lastmod: "2026-11-25T00:00:00Z" });
    const c = microsoft.fingerprint?.({ id: "1", lastmod: "2026-11-26T00:00:00Z" });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("fetches the description for one position through position_details", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("microsoft-detail"));
    const posting: RawPosting = { id: "1970393557071956", listing: rowsOf()[0]! };
    const detail = await microsoft.detail?.(src, posting, ctx);
    expect(urls).toEqual([
      "https://apply.careers.microsoft.com/api/pcsx/position_details?position_id=1970393557071956&domain=microsoft.com&hl=en",
    ]);
    expect(obj(detail).jobDescription).toBeTruthy();
  });

  it("maps the listing with its detail", async () => {
    const detail = obj(fixture("microsoft-detail")).data as Json;
    const listing = rowsOf()[0] as RawPosting["listing"];
    const job = microsoft.map({ id: "1970393557071956", listing, detail }, src);
    expect(job).toMatchObject({
      postingId: "1970393557071956",
      title: "Digital Enterprise Support Specialist- Services Sales",
      url: "https://apply.careers.microsoft.com/careers/job/1970393557071956",
      workMode: "onsite",
      employmentType: "Full-Time",
      requisitionId: "200067008",
      department: "Digital Solution Area Specialists",
      compensation: [],
    });
    expect(job.postedAt).toBe(new Date((obj(listing).postedTs as number) * 1000).toISOString());
    expect(job.locations.map((l) => l.text)).toContain("India, Karnataka, Bangalore");
    expect(job.locations.filter((l) => l.primary)).toHaveLength(1);
    expect(job.description).toMatch(/Enterprise Digital Sales/);
    expect(job.description).not.toMatch(/<\w+>/);
    const prepared = await prepareJob(job, src, sha);
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
  });

  it("maps a listing alone without inventing a description", () => {
    const job = microsoft.map({ id: "5", listing: rowsOf()[1] as RawPosting["listing"] }, src);
    expect(job.description).toBe("");
    expect(job.url).toBe("https://apply.careers.microsoft.com/careers/job/5");
  });

  it("validates the source key", () => {
    expect(() => platformFor(source("microsoft", "other.com"))).toThrow(/microsoft\.com/);
    expect(() => platformFor(src)).not.toThrow();
  });
});

describe("starbucks", () => {
  const src = source("starbucks", "starbucks.com");
  const rowsOf = (): Json[] => arr(obj(obj(fixture("starbucks-list")).data).positions);

  it("lists from the Starbucks sitemap and reads the total from its own host", async () => {
    const xml =
      "<urlset><url><loc>https://apply.starbucks.com/careers/job/481081982284-barista-store-1?domain=starbucks.com</loc><lastmod>2026-09-02T14:42:22Z</lastmod></url></urlset>";
    const urls: string[] = [];
    const http: Http = {
      getText: async (url) => {
        urls.push(url);
        return { status: 200, url, data: xml };
      },
      getJson: async (url) => {
        urls.push(url);
        return { status: 200, url, data: { status: 200, data: { count: 1, positions: [] } } };
      },
      postJson: async () => {
        throw new Error("unexpected postJson");
      },
    };
    const { items, result } = await drain(
      starbucks.list(src, { http, maxPostings: 1_000, record: () => {} }),
    );
    expect(urls).toEqual([
      "https://apply.starbucks.com/careers/sitemap.xml?domain=starbucks.com",
      "https://apply.starbucks.com/api/pcsx/search?domain=starbucks.com&query=&location=&start=0&sort_by=timestamp",
    ]);
    expect(items.map((i) => i.id)).toEqual(["481081982284"]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("fetches one position's detail from the Starbucks host", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("starbucks-detail"));
    await starbucks.detail?.(src, { id: "481081982284", listing: rowsOf()[0]! }, ctx);
    expect(urls).toEqual([
      "https://apply.starbucks.com/api/pcsx/position_details?position_id=481081982284&domain=starbucks.com&hl=en",
    ]);
  });

  it("maps the stated pay text, function, expiry and link without inventing facts", async () => {
    const detail = obj(fixture("starbucks-detail")).data as Json;
    const job = starbucks.map(
      { id: "481081982284", listing: rowsOf()[0] as RawPosting["listing"], detail },
      src,
    );
    expect(job).toMatchObject({
      postingId: "481081982284",
      url: "https://apply.starbucks.com/careers/job/481081982284",
      department: "Shift Supervisor",
      workMode: "onsite",
      compensation: [],
      expiresAt: new Date(1802840400 * 1000).toISOString(),
      extras: {
        jobFunction: "Retail Stores",
        hiringBand: "Team Leader",
        payRange: "19.37 to 21.99 USD",
      },
    });
    expect(job.employmentType).toBeUndefined();
    expect(job.description).toMatch(/Crafting the world/);
    const prepared = await prepareJob(job, src, sha);
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
  });

  it("accepts only its own domain and links only its own host", () => {
    expect(() => platformFor(source("starbucks", "microsoft.com"))).toThrow(/starbucks\.com/);
    const listing = rowsOf()[0] as RawPosting["listing"];
    const job = starbucks.map(
      { id: "9", listing, detail: { publicUrl: "https://evil.example/x" } },
      src,
    );
    expect(job.url).toBe("https://apply.starbucks.com/careers/job/9");
  });
});
