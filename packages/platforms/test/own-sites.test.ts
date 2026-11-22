import { prepareJob } from "@tallo/catalog";
import type { Json, RawPosting } from "@tallo/contracts";
import { arr, jobFactsSchema, obj } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { goldman, ibm, microsoft, platformFor, SchemaError, starbucks } from "../src/index.ts";
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
  const row = (n: number): Json => ({ id: 1_000_000 + n, name: `Job ${n}` });
  const page = (from: number, count: number, total: number): Json => ({
    status: 200,
    data: { count: total, positions: Array.from({ length: count }, (_, i) => row(from + i)) },
  });
  const startOf = (url: string): number => Number(new URL(url).searchParams.get("start"));

  it("lists the fixture rows untouched and reads the stated count", async () => {
    const { ctx, urls } = fakeCtx(() => ({
      ...obj(fixture("microsoft-list")),
      data: { ...obj(obj(fixture("microsoft-list")).data), count: 2 },
    }));
    const { items, result } = await drain(microsoft.list(src, ctx));
    expect(urls).toEqual([
      "https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=&location=&start=0&sort_by=timestamp",
    ]);
    expect(items.map((i) => i.listing)).toEqual(rowsOf());
    expect(items.map((i) => i.id)).toEqual(["1970393557071956", "1970393557040981"]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("pages 10 rows at a time to the reported count", async () => {
    const { ctx, urls } = fakeCtx((url) => {
      const start = startOf(url);
      return page(start, start === 20 ? 5 : 10, 25);
    });
    const { items, result } = await drain(microsoft.list(src, ctx));
    expect(urls.map(startOf)).toEqual([0, 10, 20]);
    expect(items).toHaveLength(25);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("is incomplete on a moved count, a short interior page, repeats or a cut-off end", async () => {
    const moved = fakeCtx((url) => page(startOf(url), 10, startOf(url) === 0 ? 20 : 21));
    expect((await drain(microsoft.list(src, moved.ctx))).result.complete).toBe(false);

    const short = fakeCtx((url) => page(startOf(url), startOf(url) === 0 ? 4 : 10, 20));
    expect((await drain(microsoft.list(src, short.ctx))).result.complete).toBe(false);

    const repeat = fakeCtx(() => page(0, 10, 20));
    const r = await drain(microsoft.list(src, repeat.ctx));
    expect(r.items).toHaveLength(10);
    expect(r.result.complete).toBe(false);

    const cut = fakeCtx((url) => page(startOf(url), startOf(url) === 0 ? 10 : 0, 20));
    const c = await drain(microsoft.list(src, cut.ctx));
    expect(c.items).toHaveLength(10);
    expect(c.result.complete).toBe(false);
  });

  it("throws on error envelopes and malformed answers", async () => {
    for (const body of [
      "Please try again later",
      { status: 500, data: { count: 1, positions: [] } },
      { status: 200 },
      { status: 200, data: { positions: [] } },
      { status: 200, data: { count: 1 } },
      { status: 200, data: { count: 1, positions: [{ name: "no id" }] } },
      { status: 200, data: { count: 1, positions: [{ id: "abc" }] } },
      page(0, 11, 11),
    ]) {
      const { ctx } = fakeCtx(() => body as Json);
      await expect(drain(microsoft.list(src, ctx))).rejects.toThrow(SchemaError);
    }
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

  it("drops only counters and ranking from the fingerprint", () => {
    const base = obj(rowsOf()[0]);
    const a = microsoft.fingerprint?.({ ...base, stars: 1, solrScore: 3, isHot: 1 });
    const b = microsoft.fingerprint?.({ ...base, stars: 9, solrScore: 1, isHot: 0 });
    expect(a).toEqual(b);
    expect(obj(a).name).toBe(base.name);
  });

  it("validates the source key", () => {
    expect(() => platformFor(source("microsoft", "other.com"))).toThrow(/microsoft\.com/);
    expect(() => platformFor(src)).not.toThrow();
  });
});

describe("starbucks", () => {
  const src = source("starbucks", "starbucks.com");
  const rowsOf = (): Json[] => arr(obj(obj(fixture("starbucks-list")).data).positions);

  it("lists the fixture rows from the Starbucks host with its domain", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("starbucks-list"));
    const { items, result } = await drain(starbucks.list(src, ctx));
    expect(urls).toEqual([
      "https://apply.starbucks.com/api/pcsx/search?domain=starbucks.com&query=&location=&start=0&sort_by=timestamp",
    ]);
    expect(items.map((i) => i.listing)).toEqual(rowsOf());
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
