import type { CollectContext, HttpInit, HttpResponse, Json, RawPosting } from "@tallo/contracts";
import { arr, obj } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import {
  ashby,
  greenhouse,
  lever,
  oraclecloud,
  platformFor,
  recruitee,
  SchemaError,
  smartrecruiters,
  workable,
  workday,
} from "../src/index.ts";
import { drain, fakeCtx, fixture, source } from "./helpers.ts";

const jobs = (name: string, key: string): Json[] => obj(fixture(name))[key] as Json[];

/** A ctx whose Http answers 304 to a matching If-None-Match and 200 with an ETag otherwise. */
function etagCtx(etag: string, body: Json, validator?: string) {
  const sent: (Record<string, string> | undefined)[] = [];
  const respond = async (url: string, init?: HttpInit): Promise<HttpResponse> => {
    sent.push(init?.headers);
    return init?.headers?.["if-none-match"] === etag
      ? { status: 304, url, data: null, etag }
      : { status: 200, url, data: body, etag };
  };
  const ctx: CollectContext = {
    http: {
      getJson: respond,
      postJson: async () => fail("no POST"),
      getText: async () => fail("no text"),
    },
    maxPostings: 1000,
    record() {},
    ...(validator ? { validator } : {}),
  };
  return { ctx, sent };
}
const fail = (msg: string): never => {
  throw new Error(msg);
};

describe.each([
  ["greenhouse", greenhouse, "greenhouse-list"],
  ["ashby", ashby, "ashby-list"],
] as const)("%s conditional listing", (name, platform, fixtureName) => {
  const src = source(name, "acme");
  it("sends no validator on a first run and returns the response ETag", async () => {
    const { ctx, sent } = etagCtx('W/"v1"', fixture(fixtureName));
    const { items, result } = await drain(platform.list(src, ctx));
    expect(sent[0]?.["if-none-match"]).toBeUndefined();
    expect(items.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ complete: true, validator: 'W/"v1"' });
    expect(result.notModified).toBeUndefined();
  });
  it("sends the stored validator and reports a 304 as notModified without yielding", async () => {
    const { ctx, sent } = etagCtx('W/"v1"', fixture(fixtureName), 'W/"v1"');
    const { items, result } = await drain(platform.list(src, ctx));
    expect(sent[0]?.["if-none-match"]).toBe('W/"v1"');
    expect(items).toEqual([]);
    expect(result).toEqual({
      complete: true,
      emptyIsAuthoritative: false,
      notModified: true,
      validator: 'W/"v1"',
    });
  });
  it("lists in full when the board changed since the stored validator", async () => {
    const { ctx } = etagCtx('W/"v2"', fixture(fixtureName), 'W/"v1"');
    const { items, result } = await drain(platform.list(src, ctx));
    expect(items.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ validator: 'W/"v2"' });
  });
});

describe("platforms without a verified conditional listing", () => {
  it.each([
    ["lever", lever, "lever-list"],
    ["smartrecruiters", smartrecruiters, null],
  ] as const)("%s never sends a validator", async (name, platform, fixtureName) => {
    const sent: unknown[] = [];
    const ctx: CollectContext = {
      http: {
        getJson: async (url, init) => {
          sent.push(init?.headers);
          return {
            status: 200,
            url,
            data: fixtureName ? fixture(fixtureName) : { content: [], totalFound: 0 },
          };
        },
        postJson: async () => fail("no POST"),
        getText: async () => fail("no text"),
      },
      maxPostings: 1000,
      record() {},
      validator: 'W/"v1"',
    };
    const { result } = await drain(platform.list(source(name, "acme"), ctx));
    expect(sent.every((h) => h === undefined)).toBe(true);
    expect(result.validator).toBeUndefined();
  });
});

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
    expect(urls).toEqual([
      "https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true&pay_transparency=true",
    ]);
    expect(items.map((i) => i.listing)).toEqual(jobs("greenhouse-list", "jobs"));
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });
  it("maps pay transparency, locations and description from detail", () => {
    const detail = fixture("greenhouse-detail");
    const raw: RawPosting = { id: "5456619008", listing: detail, detail };
    const job = greenhouse.map(raw, source("greenhouse", "anthropic"));
    expect(job).toMatchObject({
      postingId: "5456619008",
      title: "3P Revenue Accounting & Reporting",
      department: "Finance",
    });
    expect(job.compensation[0]).toMatchObject({
      min: 190000,
      max: 230000,
      currency: "USD",
      interval: "year",
      component: "base",
    });
    expect(job.locations.map((l) => l.text)).toEqual(
      expect.arrayContaining(["San Francisco, CA", "Seattle, WA"]),
    );
    // Greenhouse states only the place's name; the country is not read from "San Francisco, CA".
    expect(job.locations[0]).toMatchObject({ primary: true, text: "San Francisco, CA" });
    expect(job.locations[0]?.countryCode).toBeUndefined();
    expect(job.description.length).toBeGreaterThan(500);
    expect(job.description).not.toContain("<");
  });
  it("keeps a Greenhouse pay range's interval unknown unless its title states one", () => {
    const listing = {
      id: 1,
      title: "Engineer",
      pay_input_ranges: [
        { min_cents: 9000000, max_cents: 12000000, currency_type: "USD", title: "Salary" },
      ],
    };
    const job = greenhouse.map(
      { id: "1", listing, detail: undefined },
      source("greenhouse", "acme"),
    );
    expect(job.compensation).toEqual([
      {
        min: 90000,
        max: 120000,
        currency: "USD",
        interval: "unknown",
        component: "base",
        text: "Salary",
      },
    ]);
  });
  it("treats a malformed response as a failed run, not an empty board", async () => {
    const { ctx } = fakeCtx(() => ({ unexpected: true }));
    await expect(drain(greenhouse.list(src, ctx))).rejects.toThrow(/Expected array/);
  });

  it("reads the work mode from the Location Type label", () => {
    const detail = fixture("greenhouse-detail");
    const job = greenhouse.map({ id: "5456619008", listing: detail, detail }, src);
    // The detail's metadata states "Location Type: On-Site" and no Workplace Type.
    expect(job.workMode).toBe("onsite");
    expect(job.requisitionId).toBe("REQ-26-1145-01");
    const hybrid = greenhouse.map(
      {
        id: "9",
        listing: {
          id: 9,
          title: "Analyst",
          metadata: [{ id: 1, name: "Location Type", value: "Hybrid (Travel-Required)" }],
        },
        detail: undefined,
      },
      src,
    );
    expect(hybrid.workMode).toBe("hybrid");
  });

  it("drops the 'See Opening ID' placeholder requisition id instead of storing it", () => {
    const row = jobs("greenhouse-list", "jobs")[0]!;
    expect(obj(row).requisition_id).toBe("See Opening ID");
    const job = greenhouse.map({ id: "1", listing: row, detail: undefined }, src);
    expect(job.requisitionId).toBeUndefined();
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
    const listing = {
      ...obj((fixture("lever-list") as Json[])[0]),
      salaryRange: { currency: "USD", interval: "per-hour-wage", min: 40, max: 55 },
    };
    const job = lever.map({ id: "x", listing }, src);
    expect(job.compensation).toEqual([
      { min: 40, max: 55, currency: "USD", interval: "hour", component: "base" },
    ]);
  });
  it("leaves the pay interval unknown when the source does not state it, whatever the amount", () => {
    const listing = {
      ...obj((fixture("lever-list") as Json[])[0]),
      salaryRange: { currency: "USD", min: 90000, max: 120000 },
    };
    const job = lever.map({ id: "x", listing }, src);
    expect(job.compensation).toEqual([
      { min: 90000, max: 120000, currency: "USD", interval: "unknown", component: "base" },
    ]);
  });

  it("hints the posting's country on the primary location only", () => {
    const base = obj((fixture("lever-list") as Json[])[0]);
    const listing = {
      ...base,
      country: "SG",
      categories: {
        ...obj(base.categories),
        allLocations: ["Singapore, Singapore", "Tokyo, Japan"],
      },
    };
    const job = lever.map({ id: "x", listing }, src);
    expect(job.locations).toHaveLength(2);
    expect(job.locations[0]).toMatchObject({ primary: true, countryCode: "SG" });
    // The posting's country does not describe the second place; it stays unknown.
    expect(job.locations[1]?.countryCode).toBeUndefined();
    expect(job.locations[1]?.primary).toBeUndefined();
  });
});

describe("workable", () => {
  const src = source("workable", "huggingface");
  it("lists the whole board from one request and maps structured fields", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("workable-list"));
    const { items, result } = await drain(workable.list(src, ctx));
    expect(urls).toHaveLength(1);
    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe("81B46579FE");
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
    const job = workable.map(items[0]!, src);
    expect(job.title).toContain("Machine Learning");
    expect(job.applyUrl).toBe("https://apply.workable.com/j/81B46579FE/apply");
    expect(job.workMode).toBe("remote");
    expect(job.locations[0]).toMatchObject({ city: "Paris", countryCode: "FR", primary: true });
    expect(job.department).toBe("Open Source");
    expect(job.employmentType).toBe("Full-time");
    expect(job.postedAt).toBe("2026-05-29");
    expect(job.description.length).toBeGreaterThan(200);
    expect(job.compensation).toEqual([]);
    expect(job.extras).toEqual({ function: "Engineering", industry: "Computer Software" });
  });
  it("leaves blank source strings unset and maps country-only locations", async () => {
    const { ctx } = fakeCtx(() => fixture("workable-list"));
    const { items } = await drain(workable.list(src, ctx));
    const job = workable.map(items[1]!, src);
    expect(job.employmentType).toBeUndefined();
    expect(job.requisitionId).toBe("304379");
    expect(job.locations[0]).toMatchObject({ text: "Netherlands", countryCode: "NL" });
    expect(job.locations[0]?.city).toBeUndefined();
  });
  it("falls back to the job-level place when every per-place entry is blank", async () => {
    const { ctx } = fakeCtx(() => fixture("workable-list"));
    const { items } = await drain(workable.list(src, ctx));
    const job = items[0]!;
    const [first, second] = jobs("workable-list", "jobs");
    const noPlaces = workable.map({ id: job.id, listing: { ...obj(first), locations: [] } }, src);
    expect(noPlaces.locations).toEqual([
      {
        text: "Paris, Île-de-France, France",
        city: "Paris",
        region: "Île-de-France",
        country: "France",
        countryCode: "FR",
        remote: true,
        primary: true,
      },
    ]);
    const blankPlace = workable.map(
      {
        id: job.id,
        listing: { ...obj(second), locations: [{ city: "", region: "", country: "" }] },
      },
      src,
    );
    expect(blankPlace.locations[0]).toMatchObject({
      text: "Netherlands",
      countryCode: "NL",
      primary: true,
    });
    expect(blankPlace.locations[0]?.city).toBeUndefined();
  });
  it("fails on a malformed response and keeps an empty board non-authoritative", async () => {
    await expect(drain(workable.list(src, fakeCtx(() => ({ jobs: "x" })).ctx))).rejects.toThrow(
      SchemaError,
    );
    await expect(drain(workable.list(src, fakeCtx(() => []).ctx))).rejects.toThrow(SchemaError);
    const { result } = await drain(workable.list(src, fakeCtx(() => ({ jobs: [] })).ctx));
    expect(result.emptyIsAuthoritative).toBe(false);
  });
});

describe("ashby", () => {
  const src = source("ashby", "ramp");
  it("maps components, secondary locations and workplace type", async () => {
    const { ctx } = fakeCtx(() => fixture("ashby-list"));
    const { items } = await drain(ashby.list(src, ctx));
    const job = ashby.map(items[0]!, src);
    expect(job.compensation.find((c) => c.component === "base")).toMatchObject({
      currency: "USD",
      interval: "year",
    });
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
    expect(job).toMatchObject({
      title: "Associate Software Engineer",
      requisitionId: "JB0076564",
      department: "Engineering, Infrastructure and Operations",
    });
    expect(job.locations[0]).toMatchObject({ countryCode: "US", city: "Santa Clara" });
    expect(job.description).toContain("Company Description");
    expect(job.extras).toHaveProperty("customFields");
  });
  it("maps the scheduled unpublish date as the expiry", () => {
    const listing = { id: "1", name: "Nurse", unpublishOn: "2026-12-01T05:00:00.000Z" };
    expect(smartrecruiters.map({ id: "1", listing }, src).expiresAt).toBe(
      "2026-12-01T05:00:00.000Z",
    );
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

  it("accepts a well-formed empty listing without making it authoritative", async () => {
    const { ctx } = fakeCtx(() => ({ total: 0, jobPostings: [], facets: [] }));
    const { items, result } = await drain(workday.list(src, ctx));
    expect(items).toEqual([]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("keeps collecting when later pages report a larger total", async () => {
    const all = Array.from({ length: 41 }, (_, i) => row(i));
    const { ctx } = fakeCtx((_u, body) => {
      const offset = obj(body).offset as number;
      return {
        total: offset === 0 ? 40 : 41,
        jobPostings: all.slice(offset, offset + 20),
        facets: [],
      };
    });
    const { items, result } = await drain(workday.list(src, ctx));
    expect(items).toHaveLength(41);
    expect(result.complete).toBe(true);
  });

  it("skips a posting without externalPath as a non-blocking issue, keeping the listing complete", async () => {
    const { externalPath: _gone, ...unidentified } = obj(row(0));
    const { ctx, issues } = fakeCtx(() => ({
      total: 3,
      jobPostings: [row(1), unidentified, row(2)],
      facets: [],
    }));
    const { items, result } = await drain(workday.list(src, ctx));
    expect(items.map((i) => i.id)).toEqual(["/job/x/1", "/job/x/2"]);
    // The unidentified row is one of the three the board reported, so nothing is missing.
    expect(result.complete).toBe(true);
    expect(issues).toEqual([
      { code: "schema", message: "Workday posting without externalPath skipped" },
    ]);
  });

  it("keeps a real AccentureCareers listing complete when one row has no externalPath", async () => {
    const accenture = source("workday", "accenture/AccentureCareers", { wd: "wd103" });
    const page = fixture("workday-accenture-list") as { total: number; jobPostings: Json[] };
    const { ctx, issues } = fakeCtx(() => page);
    const { items, result } = await drain(workday.list(accenture, ctx));
    expect(items.map((i) => i.id)).toHaveLength(2);
    expect(result.complete).toBe(true);
    expect(issues.map((i) => i.message)).toEqual(["Workday posting without externalPath skipped"]);
  });

  it("counts a row without externalPath once, however many pages repeat it", async () => {
    const unidentified = { bulletFields: ["R00338212", "London"] };
    const { ctx, issues } = fakeCtx((_u, body) => {
      const offset = obj(body).offset as number;
      // Two real pages of 20 rows, so 39 distinct rows in all, one of them unidentifiable.
      const page = Array.from({ length: 19 }, (_, i) => row(offset + i));
      return { total: 39, jobPostings: [...page, unidentified], facets: [] };
    });
    const { items, result } = await drain(workday.list(src, ctx));
    expect(items).toHaveLength(38);
    expect(result.complete).toBe(true);
    expect(issues.filter((i) => i.message.includes("externalPath"))).toHaveLength(1);
  });

  it("still reports a real shortfall when duplicate pages hide missing postings", async () => {
    const unidentified = { bulletFields: ["R1"] };
    const { ctx, issues } = fakeCtx(() => ({
      total: 40,
      jobPostings: [...Array.from({ length: 19 }, (_, i) => row(i)), unidentified],
      facets: [],
    }));
    const { items, result } = await drain(workday.list(src, ctx));
    expect(items).toHaveLength(19);
    expect(result.complete).toBe(false);
    expect(issues).toContainEqual({
      code: "pagination",
      message: "Workday listing has 20 jobs, fewer than reported 40",
    });
  });

  it.each([
    [422, /HTTP 422 on the first request: the tenant is not served/],
    [403, /HTTP 403 \(permission denied\) on the first request/],
  ])(
    "turns a first-request %i into a readable failed run that never claims a 404",
    async (status, message) => {
      const ctx: CollectContext = {
        http: {
          getJson: async () => {
            throw Object.assign(new Error(`HTTP ${status}`), { status });
          },
          postJson: async () => {
            throw Object.assign(new Error(`HTTP ${status}`), { status });
          },
          getText: async () => {
            throw Object.assign(new Error(`HTTP ${status}`), { status });
          },
        },
        maxPostings: 1_000_000,
        record: () => {},
      };
      await expect(drain(workday.list(src, ctx))).rejects.toThrow(message);
    },
  );

  it("leaves a later-page rejection to the engine unchanged", async () => {
    const { ctx } = fakeCtx((_u, body) => {
      if (obj(body).offset === 0)
        return { total: 40, jobPostings: Array.from({ length: 20 }, (_, i) => row(i)), facets: [] };
      throw Object.assign(new Error("HTTP 422"), { status: 422 });
    });
    const failing: CollectContext = {
      ...ctx,
      http: {
        ...ctx.http,
        postJson: async (url, body) => {
          if (obj(body).offset === 0) return ctx.http.postJson(url, body);
          throw Object.assign(new Error("HTTP 422"), { status: 422 });
        },
      },
    };
    await expect(drain(workday.list(src, failing))).rejects.toThrow("HTTP 422");
  });

  it.each([undefined, null, -1, 1.5, "20", Number.POSITIVE_INFINITY])(
    "rejects an invalid reported total %s instead of inferring a complete listing",
    async (total) => {
      const { ctx } = fakeCtx(() => ({
        ...(total === undefined ? {} : { total }),
        jobPostings: [row(1)],
        facets: [],
      }));
      await expect(drain(workday.list(src, ctx))).rejects.toBeInstanceOf(SchemaError);
    },
  );

  it("validates the reported total on later pages too", async () => {
    const { ctx } = fakeCtx((_u, body) => ({
      ...(obj(body).offset === 0 ? { total: 40 } : {}),
      jobPostings: Array.from({ length: 20 }, (_, i) => row((obj(body).offset as number) + i)),
      facets: [],
    }));
    await expect(drain(workday.list(src, ctx))).rejects.toBeInstanceOf(SchemaError);
  });

  it("reports duplicate pages that leave fewer unique jobs than advertised as incomplete", async () => {
    const { ctx, issues } = fakeCtx(() => ({
      total: 40,
      jobPostings: Array.from({ length: 20 }, (_, i) => row(i)),
      facets: [],
    }));
    const { items, result } = await drain(workday.list(src, ctx));
    expect(items).toHaveLength(20);
    expect(result.complete).toBe(false);
    expect(issues).toContainEqual({
      code: "pagination",
      message: "Workday listing has 20 jobs, fewer than reported 40",
    });
  });

  it("reports capped boards whose facets do not cover the reported total as incomplete", async () => {
    const { ctx, issues } = fakeCtx((_u, body) => {
      const { offset, appliedFacets } = obj(body) as {
        offset: number;
        appliedFacets: Record<string, string[]>;
      };
      const filtered = !!appliedFacets.state;
      return {
        total: filtered ? 20 : 2500,
        jobPostings: Array.from({ length: 20 }, (_, i) => row(offset + i)),
        facets: filtered
          ? []
          : [
              {
                facetParameter: "state",
                values: [
                  { id: "a", count: 20 },
                  { id: "b", count: 20 },
                ],
              },
            ],
      };
    });
    const { items, result } = await drain(workday.list(src, ctx));
    expect(items).toHaveLength(2000);
    expect(result.complete).toBe(false);
    expect(issues).toContainEqual({
      code: "pagination",
      message: "Workday listing has 2000 jobs, fewer than reported 2500",
    });
  });

  it.each([
    [0, 0],
    [0, 7],
    [20, 7],
  ])(
    "reports a premature page at offset %i with %i rows as incomplete",
    async (shortOffset, count) => {
      const { ctx, issues } = fakeCtx((_u, body) => {
        const offset = obj(body).offset as number;
        return {
          total: 50,
          jobPostings: Array.from({ length: offset === shortOffset ? count : 20 }, (_, i) =>
            row(offset + i),
          ),
          facets: [],
        };
      });
      const { items, result } = await drain(workday.list(src, ctx));
      expect(items).toHaveLength(shortOffset + count);
      expect(result.complete).toBe(false);
      expect(issues).toEqual([
        {
          code: "pagination",
          message: `Workday short page at offset ${shortOffset}: received ${count} of 50 jobs`,
        },
      ]);
    },
  );

  it("propagates a premature facet page to the whole listing without losing other slices", async () => {
    const facets = [
      {
        facetParameter: "state",
        values: [
          { id: "a", count: 30 },
          { id: "b", count: 20 },
        ],
      },
    ];
    const { ctx, issues } = fakeCtx((_u, body) => {
      const { offset, appliedFacets } = obj(body) as {
        offset: number;
        appliedFacets: Record<string, string[]>;
      };
      const state = appliedFacets.state?.[0];
      if (!state)
        return {
          total: 2000,
          jobPostings: Array.from({ length: 20 }, (_, i) => row(1000 + offset + i)),
          facets,
        };
      const count = state === "a" && offset === 20 ? 5 : 20;
      return {
        total: state === "a" ? 30 : 20,
        jobPostings: Array.from({ length: count }, (_, i) =>
          row((state === "a" ? 0 : 100) + offset + i),
        ),
        facets: [],
      };
    });
    const { items, result } = await drain(workday.list(src, ctx));
    expect(result.complete).toBe(false);
    expect(issues).toEqual([
      { code: "pagination", message: "Workday short page at offset 20: received 5 of 30 jobs" },
    ]);
    expect(items.some((posting) => posting.id === "/job/x/24")).toBe(true);
    expect(items.some((posting) => posting.id === "/job/x/119")).toBe(true);
  });

  it("splits capped boards by facet and dedupes overlap", async () => {
    // Two 1,251-job facets cover the 2,501-job board with one overlapping posting.
    const states: Record<string, Json[]> = {
      a: Array.from({ length: 1251 }, (_, i) => row(i)),
      b: Array.from({ length: 1251 }, (_, i) => row(i + 1250)),
    };
    const facets = [
      {
        facetParameter: "state",
        values: [
          { id: "a", count: 1251 },
          { id: "b", count: 1251 },
        ],
      },
    ];
    const { ctx } = fakeCtx((_u, body) => {
      const { appliedFacets, offset } = obj(body) as {
        appliedFacets: Record<string, string[]>;
        offset: number;
      };
      const id = appliedFacets.state?.[0];
      if (!id)
        return {
          total: 2501,
          jobPostings: Array.from({ length: 20 }, (_, i) => row(offset + i)),
          facets,
        };
      return { total: 1251, jobPostings: states[id]!.slice(offset, offset + 20), facets: [] };
    });
    const { items, result } = await drain(workday.list(src, ctx));
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items).toHaveLength(2501);
    expect(result.complete).toBe(true);
  });

  it("reports an unsplittable capped slice as incomplete and never reads past the 2,000 window", async () => {
    const offsets: number[] = [];
    const { ctx, issues } = fakeCtx((_u, body) => {
      const offset = obj(body).offset as number;
      offsets.push(offset);
      return {
        total: 2000,
        jobPostings: Array.from({ length: 20 }, (_, i) => row(offset + i)),
        facets: [],
      };
    });
    const { result } = await drain(workday.list(src, ctx));
    expect(result.complete).toBe(false);
    expect(issues[0]?.code).toBe("pagination");
    expect(Math.max(...offsets)).toBe(1980);
  });

  it("ignores the relative posted date in the fingerprint and maps detail", () => {
    const a = workday.fingerprint!({ title: "t", postedOn: "Posted Today" });
    expect(a).toEqual(workday.fingerprint!({ title: "t", postedOn: "Posted 3 Days Ago" }));
    const detail = fixture("workday-detail");
    const job = workday.map({ id: "/job/x/1", listing: list.jobPostings[0]!, detail }, src);
    expect(job).toMatchObject({
      title: "Lead Warehouse Worker",
      requisitionId: "R0000476959",
      employmentType: "Full time",
      postedAt: "2026-10-23",
    });
    expect(job.locations[0]?.countryCode).toBe("US");
    expect(job.description).toContain("pay range");
  });

  it("takes the country code from the requisition location's alpha-2, else from the country name", () => {
    const detail = fixture("workday-detail");
    const info = obj(obj(detail).jobPostingInfo);
    const reqLoc = obj(info.jobRequisitionLocation);
    const id = "/job/x/1";
    const coded = workday.map({ id, listing: list.jobPostings[0]!, detail }, src);
    expect(coded.locations[0]).toMatchObject({ primary: true, countryCode: "US" });

    // No requisition location: the posting's country name is the only structured country.
    const named = workday.map(
      {
        id,
        listing: list.jobPostings[0]!,
        detail: { ...obj(detail), jobPostingInfo: { ...info, jobRequisitionLocation: null } },
      },
      src,
    );
    expect(named.locations[0]?.countryCode).toBe("US");

    // The alpha-2 code wins over a name when the source states both.
    const alpha2 = workday.map(
      {
        id,
        listing: list.jobPostings[0]!,
        detail: {
          ...obj(detail),
          jobPostingInfo: {
            ...info,
            jobRequisitionLocation: {
              ...reqLoc,
              country: { ...obj(reqLoc.country), alpha2Code: "CA" },
            },
          },
        },
      },
      src,
    );
    expect(alpha2.locations[0]?.countryCode).toBe("CA");
  });
});

describe("oraclecloud", () => {
  const src = source("oraclecloud", "eluq.fa.us2.oraclecloud.com", { siteNumber: "CX_2001" });
  const rowsFx = obj((obj(fixture("oraclecloud-list")).items as Json[])[0])
    .requisitionList as Json[];
  const siteOfUrl = (url: string) => /siteNumber=([^,]+)/.exec(url)?.[1];
  const emptyBoard = { items: [{ TotalJobsCount: 0, requisitionList: [] }] };
  /**
   * Serves `total` postings for CX_2001 in pages, like the finder (100 per page, capped at 10,000).
   * Any other site, including the sentinel probe, sees an empty board.
   */
  const pages = (total: number) =>
    fakeCtx((url) => {
      if (siteOfUrl(url) !== "CX_2001") return emptyBoard;
      const offset = Number(/offset=(\d+)/.exec(url)?.[1]);
      const rowsAt = offset < total ? Math.min(100, total - offset) : 0;
      const requisitionList = Array.from({ length: rowsAt }, (_, i) => ({
        ...obj(rowsFx[0]),
        Id: String(offset + i),
      }));
      return { items: [{ TotalJobsCount: total, requisitionList }] };
    });
  const realCalls = (urls: string[]) => urls.filter((u) => siteOfUrl(u) === "CX_2001");
  const probeCalls = (urls: string[]) => urls.filter((u) => siteOfUrl(u) !== "CX_2001");

  it("pages the finder until TotalJobsCount and keeps rows untouched", async () => {
    const { ctx, urls } = pages(250);
    const { items, result } = await drain(oraclecloud.list(src, ctx));
    expect(realCalls(urls)).toHaveLength(3);
    expect(realCalls(urls)[0]).toContain(
      "finder=findReqs;siteNumber=CX_2001,limit=100,offset=0,keyword=",
    );
    expect(items).toHaveLength(250);
    expect(items[0]?.listing).toEqual({ ...obj(rowsFx[0]), Id: "0" });
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("probes an impossible siteNumber once and proceeds when the answer differs", async () => {
    const { ctx, urls } = pages(250);
    await drain(oraclecloud.list(src, ctx));
    expect(probeCalls(urls)).toHaveLength(1);
    expect(probeCalls(urls)[0]).toContain("siteNumber=CX_TALLO_NO_SUCH_SITE,limit=1,offset=0");
  });

  it("refuses a configured site that answers like the host default", async () => {
    const same = fakeCtx(() => ({ items: [{ TotalJobsCount: 2, requisitionList: rowsFx }] }));
    await expect(drain(oraclecloud.list(src, same.ctx))).rejects.toThrow(/defaultSite/);
    await expect(drain(oraclecloud.list(src, same.ctx))).rejects.toBeInstanceOf(SchemaError);
  });

  it("refuses when only the first requisition Id matches the host default", async () => {
    const first = { ...obj(rowsFx[0]), Id: "NEWEST" };
    const board = fakeCtx((url) =>
      siteOfUrl(url) === "CX_2001"
        ? { items: [{ TotalJobsCount: 2975, requisitionList: [first] }] }
        : { items: [{ TotalJobsCount: 3196, requisitionList: [first] }] },
    );
    await expect(drain(oraclecloud.list(src, board.ctx))).rejects.toBeInstanceOf(SchemaError);
    await expect(drain(oraclecloud.list(src, board.ctx))).rejects.toThrow(/defaultSite/);
  });

  it("refuses when only the total matches the host default", async () => {
    const board = fakeCtx((url) =>
      siteOfUrl(url) === "CX_2001"
        ? { items: [{ TotalJobsCount: 3196, requisitionList: [{ ...obj(rowsFx[0]), Id: "A" }] }] }
        : { items: [{ TotalJobsCount: 3196, requisitionList: [{ ...obj(rowsFx[0]), Id: "B" }] }] },
    );
    await expect(drain(oraclecloud.list(src, board.ctx))).rejects.toBeInstanceOf(SchemaError);
    await expect(drain(oraclecloud.list(src, board.ctx))).rejects.toThrow(/defaultSite/);
  });

  it.each([150, 200])(
    "checks the host default before yielding after an empty first page (probe total %i)",
    async (probeTotal) => {
      const fallback = { Id: "DEFAULT", Title: "Host default job" };
      const { ctx, urls } = fakeCtx((url) => {
        if (siteOfUrl(url) !== "CX_2001")
          return { items: [{ TotalJobsCount: probeTotal, requisitionList: [fallback] }] };
        const offset = Number(/offset=(\d+)/.exec(url)?.[1]);
        return {
          items: [{ TotalJobsCount: 150, requisitionList: offset === 0 ? [] : [fallback] }],
        };
      });
      await expect(oraclecloud.list(src, ctx).next()).rejects.toThrow(/defaultSite/);
      expect(realCalls(urls)).toHaveLength(2);
      expect(probeCalls(urls)).toHaveLength(1);
    },
  );

  it("lists a host-default site only when the source acknowledges it", async () => {
    const acknowledged = source("oraclecloud", "eluq.fa.us2.oraclecloud.com", {
      siteNumber: "CX_2001",
      defaultSite: true,
    });
    const same = fakeCtx(() => ({ items: [{ TotalJobsCount: 2, requisitionList: rowsFx }] }));
    const { items, result } = await drain(oraclecloud.list(acknowledged, same.ctx));
    expect(items).toHaveLength(rowsFx.length);
    expect(result.complete).toBe(true);
    expect(probeCalls(same.urls)).toHaveLength(0);
  });

  it("does not probe an empty board, where the default cannot be told apart", async () => {
    const { ctx, urls } = fakeCtx(() => emptyBoard);
    const { items } = await drain(oraclecloud.list(src, ctx));
    expect(items).toEqual([]);
    expect(probeCalls(urls)).toHaveLength(0);
  });

  it("reports a board over the 10,000 cap as incomplete, never closable", async () => {
    const { ctx, issues } = pages(11790);
    const { result } = await drain(oraclecloud.list(src, ctx));
    expect(result.complete).toBe(false);
    expect(issues[0]?.code).toBe("pagination");
  });

  it("reports a short page before the reported total as incomplete", async () => {
    const { ctx, issues } = fakeCtx((url) =>
      siteOfUrl(url) === "CX_2001"
        ? { items: [{ TotalJobsCount: 150, requisitionList: rowsFx }] }
        : emptyBoard,
    );
    const { result } = await drain(oraclecloud.list(src, ctx));
    expect(result.complete).toBe(false);
    expect(issues[0]?.code).toBe("pagination");
  });

  it.each([99, 0])(
    "continues after an intermediate page with %i rows without claiming completeness",
    async (shortRows) => {
      const { ctx, urls, issues } = fakeCtx((url) => {
        if (siteOfUrl(url) !== "CX_2001") return emptyBoard;
        const offset = Number(/offset=(\d+)/.exec(url)?.[1]);
        const size = offset === 0 ? 100 : offset === 100 ? shortRows : 50;
        return {
          items: [
            {
              TotalJobsCount: 250,
              requisitionList: Array.from({ length: size }, (_, i) => ({
                Id: String(offset + i),
                Title: `Job ${offset + i}`,
              })),
            },
          ],
        };
      });
      const { items, result } = await drain(oraclecloud.list(src, ctx));
      expect(realCalls(urls).map((url) => Number(/offset=(\d+)/.exec(url)?.[1]))).toEqual([
        0, 100, 200,
      ]);
      expect(items).toHaveLength(150 + shortRows);
      expect(items.at(-1)).toEqual({
        id: "249",
        listing: { Id: "249", Title: "Job 249" },
      });
      expect(result).toEqual({ complete: false, emptyIsAuthoritative: false });
      expect(issues).toEqual([{ code: "pagination", message: "Short page at offset 100" }]);
    },
  );

  it("bounds requests at the cap even when every page is unexpectedly empty", async () => {
    const { ctx, urls, issues } = fakeCtx((url) =>
      siteOfUrl(url) === "CX_2001"
        ? { items: [{ TotalJobsCount: 20000, requisitionList: [] }] }
        : emptyBoard,
    );
    const { items, result } = await drain(oraclecloud.list(src, ctx));
    expect(items).toEqual([]);
    expect(realCalls(urls)).toHaveLength(100);
    expect(realCalls(urls).at(-1)).toContain("offset=9900");
    expect(result.complete).toBe(false);
    expect(issues.at(-1)?.message).toContain("caps at 10000");
  });

  it("treats an empty board as complete but not authoritative", async () => {
    const { ctx } = fakeCtx(() => emptyBoard);
    const { items, result } = await drain(oraclecloud.list(src, ctx));
    expect(items).toEqual([]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("treats a malformed response as a failed run, not an empty board", async () => {
    const { ctx } = fakeCtx(() => ({ unexpected: true }));
    await expect(drain(oraclecloud.list(src, ctx))).rejects.toThrow(/Expected array/);
  });

  it("rejects a response without TotalJobsCount", async () => {
    const { ctx } = fakeCtx(() => ({ items: [{ requisitionList: rowsFx }] }));
    await expect(drain(oraclecloud.list(src, ctx))).rejects.toBeInstanceOf(SchemaError);
  });

  it("rejects a requisition without an Id", async () => {
    const { ctx } = fakeCtx(() => ({
      items: [{ TotalJobsCount: 1, requisitionList: [{ Title: "No id" }] }],
    }));
    await expect(drain(oraclecloud.list(src, ctx))).rejects.toBeInstanceOf(SchemaError);
  });

  it("rejects a detail response with no items", async () => {
    const { ctx } = fakeCtx(() => ({ items: [] }));
    await expect(oraclecloud.detail!(src, { id: "1", listing: null }, ctx)).rejects.toBeInstanceOf(
      SchemaError,
    );
  });

  it("fetches detail by id and maps the posting from fixtures", async () => {
    const envelope = fixture("oraclecloud-detail");
    const detail = (obj(envelope).items as Json[])[0];
    const { ctx, urls } = fakeCtx(() => envelope);
    await oraclecloud.detail!(src, { id: "210574363", listing: null }, ctx);
    expect(urls[0]).toContain('finder=ById;Id="210574363",siteNumber=CX_2001');

    const job = oraclecloud.map(
      { id: "210574363", listing: rowsFx[0]!, detail },
      source("oraclecloud", "jpmc.fa.oraclecloud.com", { siteNumber: "CX_1001" }),
    );
    expect(job).toMatchObject({
      postingId: "210574363",
      applyUrl:
        "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210574363",
      employmentType: "Full time",
      team: "Advisors",
      postedAt: "2026-10-23T20:16:52+00:00",
    });
    expect(job.title).toContain("Private Client Advisor");
    // The source says "Lexington, KY, United States" and states the country; no region is read from the text.
    expect(job.locations[0]).toMatchObject({
      primary: true,
      countryCode: "US",
      text: "Lexington, KY, United States",
    });
    expect(job.locations[0]?.region).toBeUndefined();
    expect(job.description.length).toBeGreaterThan(300);
    expect(job.description).not.toContain("<");
    expect(job.extras).toMatchObject({ businessUnit: "Consumer & Community Banking" });
  });

  it("maps secondary locations from the listing", () => {
    const withSecondary = rowsFx.find((r) => arr(obj(r).secondaryLocations).length > 0)!;
    const job = oraclecloud.map({ id: "1", listing: withSecondary }, src);
    expect(job.locations.length).toBeGreaterThan(1);
  });

  it("maps the structured work location's city for the primary place, never Region1/Region2", () => {
    const detail = (obj(fixture("oraclecloud-detail")).items as Json[])[0];
    const job = oraclecloud.map({ id: "210574363", listing: rowsFx[0]!, detail }, src);
    expect(job.locations[0]).toMatchObject({ primary: true, city: "Lexington" });
    // Region1 "Fayette" and Region2 "KY" are district codes, not ISO regions, so no region is set.
    expect(job.locations[0]?.region).toBeUndefined();
    const withSecondary = rowsFx.find((r) => arr(obj(r).secondaryLocations).length > 0)!;
    const secondary = oraclecloud.map({ id: "1", listing: withSecondary }, src);
    expect(secondary.locations[1]?.city).toBeUndefined();
  });

  it("ignores per-query relevancy in the fingerprint", () => {
    const row = obj(rowsFx[0]);
    expect(oraclecloud.fingerprint!({ ...row, Relevancy: 1 })).toEqual(
      oraclecloud.fingerprint!({ ...row, Relevancy: 99 }),
    );
  });

  it("rejects hosts outside the Oracle recruiting pods and missing site numbers", () => {
    expect(() =>
      oraclecloud.validate(source("oraclecloud", "evil.example.com", { siteNumber: "CX_1" })),
    ).toThrow(/oraclecloud/);
    expect(() =>
      oraclecloud.validate(source("oraclecloud", "x.oraclecloud.com", { siteNumber: "CX_1" })),
    ).toThrow(/oraclecloud/);
    expect(() =>
      oraclecloud.validate(source("oraclecloud", "jpmc.fa.oraclecloud.com", {})),
    ).toThrow(/siteNumber/);
  });

  it("accepts the three seeded pod shapes and rejects a non-boolean defaultSite", () => {
    for (const key of [
      "jpmc.fa.oraclecloud.com",
      "eeho.fa.us2.oraclecloud.com",
      "fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com",
    ])
      expect(() =>
        oraclecloud.validate(source("oraclecloud", key, { siteNumber: "CX_1" })),
      ).not.toThrow();
    expect(() =>
      oraclecloud.validate(
        source("oraclecloud", "jpmc.fa.oraclecloud.com", {
          siteNumber: "CX_1",
          defaultSite: "yes",
        }),
      ),
    ).toThrow(/defaultSite/);
  });
});

describe("recruitee", () => {
  const src = source("recruitee", "deephealth");
  it("lists every offer from one request, untouched", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("recruitee-list"));
    const { items, result } = await drain(recruitee.list(src, ctx));
    expect(urls).toEqual(["https://deephealth.recruitee.com/api/offers/"]);
    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe("2824483");
    expect(obj(items[0]?.listing).careers_apply_url).toBeTruthy();
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });
  it("maps structured fields, string salary amounts and the stated interval", async () => {
    const { ctx } = fakeCtx(() => fixture("recruitee-list"));
    const { items } = await drain(recruitee.list(src, ctx));
    const job = recruitee.map(items[0]!, src);
    expect(job.title).toBe("Clinical Research Scientist");
    expect(job.compensation).toEqual([
      { min: 110000, max: 130000, currency: "USD", interval: "year", component: "base" },
    ]);
    expect(job.employmentType).toBe("fulltime_permanent");
    expect(job.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    expect(job.description.length).toBeGreaterThan(300);
    expect(job.locations.length).toBeGreaterThan(0);
    expect(job.extras.experience_code).toBeTruthy();
    expect(job.experience).toEqual([]);
    // remote and hybrid are both flagged: no single work mode is stated
    expect(job.workMode).toBeUndefined();
  });
  it("has no pay when the source states none, and an unstated interval is unknown", async () => {
    const { ctx } = fakeCtx(() => fixture("recruitee-list"));
    const { items } = await drain(recruitee.list(src, ctx));
    const job = recruitee.map(items[1]!, src);
    expect(job.compensation).toEqual([]);
    expect(job.workMode).toBe("hybrid");
    expect(job.locations[0]).toMatchObject({ city: "Amsterdam", countryCode: "NL", primary: true });
    const listing = {
      ...obj(items[1]?.listing),
      salary: { min: "3500", max: "4200", period: null, currency: "EUR" },
    };
    const priced = recruitee.map({ id: "x", listing }, src);
    expect(priced.compensation).toEqual([
      { min: 3500, max: 4200, currency: "EUR", interval: "unknown", component: "base" },
    ]);
  });
  it("falls back to the offer-level place when a listed location has no name or city", () => {
    const listing = {
      title: "t",
      location: "Krakow, Malopolskie, Poland",
      city: "Krakow",
      country: "Poland",
      country_code: "PL",
      locations: [{ id: 1, state: "Malopolskie", country: "Poland", country_code: "PL" }],
    };
    const job = recruitee.map({ id: "x", listing }, src);
    expect(job.locations).toHaveLength(1);
    expect(job.locations[0]).toMatchObject({ city: "Krakow", countryCode: "PL" });
  });
  it("treats an empty board as authoritative and a malformed response as a failed run", async () => {
    const empty = fakeCtx(() => ({ offers: [] }));
    const { items, result } = await drain(recruitee.list(src, empty.ctx));
    expect(items).toHaveLength(0);
    expect(result.emptyIsAuthoritative).toBe(true);
    const bad = fakeCtx(() => ({ error: "nope" }));
    await expect(drain(recruitee.list(src, bad.ctx))).rejects.toThrow(SchemaError);
  });
  it("ignores display order in the fingerprint and rejects bad keys", () => {
    const a = recruitee.fingerprint?.({ id: 1, position: 1, title: "t" });
    const b = recruitee.fingerprint?.({ id: 1, position: 9, title: "t" });
    expect(a).toEqual(b);
    expect(() => platformFor(source("recruitee", "a.evil.com"))).toThrow(/Invalid/);
  });
});
