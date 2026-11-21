import { readFileSync } from "node:fs";
import { prepareJob } from "@tallo/catalog";
import type { CollectContext, Http, Json, RawPosting } from "@tallo/contracts";
import { jobFactsSchema, obj } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { icims, SchemaError } from "../src/index.ts";
import { drain, fixture, source } from "./helpers.ts";

describe("icims", () => {
  const html = (name: string) =>
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  const src = source("icims", "careers-patternenergy");
  const lastPage = () => html("icims-list.html").replace(/<link rel="next"[^>]*\/>/, "");
  const jibe = source("icims", "careers-githubinc", { jibeHost: "www.github.careers" });
  const text = (handler: (url: string) => string) => {
    const urls: string[] = [];
    const http: Http = {
      getJson: async () => {
        throw new Error("unexpected getJson");
      },
      postJson: async () => {
        throw new Error("unexpected postJson");
      },
      getText: async (url) => {
        urls.push(url);
        return { status: 200, url, data: handler(url) };
      },
    };
    return { urls, ctx: { http, maxPostings: 1_000_000, record: () => {} } as CollectContext };
  };

  it("pages the portal through rel=next and keeps every card field", async () => {
    const { ctx, urls } = text((url) =>
      url.includes("pr=0")
        ? html("icims-list.html")
        : html("icims-list.html").replace(/<link rel="next"[^>]*\/>/, ""),
    );
    const { items, result } = await drain(icims.list(src, ctx));
    expect(urls).toEqual([
      "https://careers-patternenergy.icims.com/jobs/search?pr=0&in_iframe=1",
      "https://careers-patternenergy.icims.com/jobs/search?pr=1&in_iframe=1",
    ]);
    expect(items).toHaveLength(4);
    expect(items[0]?.id).toBe("3771");
    expect(items[0]?.listing).toMatchObject({
      title: "AP Accountant I",
      url: "https://careers-patternenergy.icims.com/jobs/3771/ap-accountant-i/job",
      fields: [{ label: "Job ID", value: "2026-3771" }],
    });
    expect(obj(items[0]?.listing).header).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Posted Date", title: "11/19/2026 4:56 PM" }),
      ]),
    );
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
  });

  it("fails loudly on shapes it does not know and treats a listings page without cards as empty", async () => {
    const empty = '<div class="iCIMS_MainWrapper iCIMS_ListingsPage">Sorry, no jobs</div>';
    const { items } = await drain(icims.list(src, text(() => empty).ctx));
    expect(items).toEqual([]);
    await expect(
      drain(icims.list(src, text(() => "<html>oops</html>").ctx)),
    ).rejects.toBeInstanceOf(SchemaError);
    const redirect =
      "<script>window.top.location.href = 'https:\\/\\/www.x.careers\\/jobs';</script>";
    await expect(drain(icims.list(src, text(() => redirect).ctx))).rejects.toThrow(/jibeHost/);
    const noLink = html("icims-list.html").replace(/href="[^"]*"( class="iCIMS_Anchor")/, "$1");
    await expect(drain(icims.list(src, text(() => noLink).ctx))).rejects.toBeInstanceOf(
      SchemaError,
    );
  });

  it("fingerprints without the relative posted date", () => {
    const base = {
      header: [{ label: "Posted Date", value: "1 day ago", title: "11/19/2026 4:56 PM" }],
    };
    const later = {
      header: [{ label: "Posted Date", value: "2 days ago", title: "11/19/2026 4:56 PM" }],
    };
    expect(icims.fingerprint?.(base)).toEqual(icims.fingerprint?.(later));
  });

  it.each<[string, string | undefined]>([
    ["United States", "US"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal unresolved template observed in source JSON-LD
    ["Hidden (${12781}", undefined],
  ])("keeps a non-code addressCountry as source text: %s", async (country, code) => {
    const job = icims.map(
      {
        id: "264564",
        listing: {
          title: "Support",
          url: "https://careers-libertymutual.icims.com/jobs/264564/support/job",
        },
        detail: {
          jsonLd: {
            description: "Support customers.",
            jobLocation: [{ address: { addressLocality: "Remote", addressCountry: country } }],
          },
        },
      },
      src,
    );
    const prepared = await prepareJob(job, src, "a".repeat(64));
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
    expect(job.locations[0]?.countryCode).toBe(code);
    expect(job.locations[0]?.country).toBe(country);
  });

  it("maps the portal card and the job page JSON-LD", async () => {
    const { ctx } = text(() => html("icims-job.html"));
    const { items } = await drain(icims.list(src, text(lastPage).ctx));
    const first = items[0] as RawPosting;
    const detail = await icims.detail?.(src, first, ctx);
    const job = icims.map({ ...first, detail }, src);
    expect(job).toMatchObject({
      postingId: "3771",
      title: "AP Accountant I",
      requisitionId: "2026-3771",
      postedAt: "2026-11-19T05:00:00.000Z",
      expiresAt: "2027-11-19T05:00:00.000Z",
    });
    // The portal states "US-PA"; the placeholder city "UNAVAILABLE" is not a place.
    expect(job.locations[0]).toMatchObject({ text: "US-PA", region: "PA", countryCode: "US" });
    expect(job.locations[0]?.city).toBeUndefined();
    expect(job.description).toContain("Dynamic Energy Solutions");
    expect(job.compensation).toEqual([]);
    expect(job.extras).toMatchObject({ occupationalCategory: "Accounting" });
  });

  it("keeps a multi-place card's places and reads other tenants' field labels", async () => {
    const { items } = await drain(
      icims.list(src, text(() => html("icims-list-facility.html")).ctx),
    );
    const job = icims.map(items[0] as RawPosting, src);
    expect(job.employmentType).toBe("Full Time");
    expect(job.locations[0]?.text).toBe("US-IL-Chicago");
    expect(job.extras).toMatchObject({
      header: [{ label: "Facility", value: "Resurrection Medical Center" }],
    });
    expect(job.description).toBe("");
  });

  it("falls back to the job page ad sections without JSON-LD", async () => {
    const { ctx } = text(() => html("icims-job-sections.html"));
    const { items } = await drain(icims.list(src, text(lastPage).ctx));
    const detail = await icims.detail?.(src, items[0] as RawPosting, ctx);
    const job = icims.map({ ...(items[0] as RawPosting), detail }, src);
    expect(job.description.length).toBeGreaterThan(100);
    await expect(
      icims.detail?.(src, items[0] as RawPosting, text(() => "<p>x</p>").ctx),
    ).rejects.toBeInstanceOf(SchemaError);
  });

  it("reads a Jibe-fronted tenant from /api/jobs and maps the row", async () => {
    const fx = fixture("icims-jibe-list") as { jobs: Json[]; totalCount: number };
    const urls: string[] = [];
    const http: Http = {
      getJson: async (url) => {
        urls.push(url);
        const page = Number(new URL(url).searchParams.get("page"));
        return {
          status: 200,
          url,
          data: { jobs: page === 1 ? fx.jobs : [fx.jobs[0]!], totalCount: 3 },
        };
      },
      postJson: async () => {
        throw new Error("x");
      },
      getText: async () => {
        throw new Error("x");
      },
    };
    const ctx = { http, maxPostings: 1_000_000, record: () => {} } as CollectContext;
    const { items, result } = await drain(icims.list(jibe, ctx));
    expect(urls).toEqual([
      "https://www.github.careers/api/jobs?page=1&limit=100",
      "https://www.github.careers/api/jobs?page=2&limit=100",
    ]);
    expect(items).toHaveLength(3);
    expect(result.complete).toBe(true);
    const job = icims.map(items[0] as RawPosting, jibe);
    expect(job).toMatchObject({
      postingId: "7998",
      title: "Principal Product Manager, Fraud & Safety",
      applyUrl: "https://careers-githubinc.icims.com/jobs/7998/login",
      url: "https://www.github.careers/jobs/7998",
      requisitionId: "7998",
      employmentType: "FULL_TIME",
    });
    expect(job.locations[0]).toMatchObject({ countryCode: "US" });
    // salary_* are 0 with no currency or interval: unstated, so no pay line.
    expect(job.compensation).toEqual([]);
    expect(job.description).toContain("GitHub");
  });

  it("rejects a Jibe response that ends early or lacks totalCount", async () => {
    const mk = (data: Json): CollectContext =>
      ({
        http: {
          getJson: async (url: string) => ({ status: 200, url, data }),
        } as unknown as CollectContext["http"],
        maxPostings: 10,
        record: () => {},
      }) as CollectContext;
    await expect(drain(icims.list(jibe, mk({ jobs: [] })))).rejects.toBeInstanceOf(SchemaError);
    await expect(drain(icims.list(jibe, mk({ jobs: [], totalCount: 5 })))).rejects.toBeInstanceOf(
      SchemaError,
    );
  });

  it("validates the tenant key and only allows known Jibe hosts", () => {
    expect(() => icims.validate(source("icims", "../x"))).toThrow(/icims/);
    expect(() => icims.validate(source("icims", "evil.example.com"))).toThrow(/icims/);
    expect(() => icims.validate(jibe)).not.toThrow();
    expect(() =>
      icims.validate(source("icims", "careers-x", { jibeHost: "evil.example.com" })),
    ).toThrow(/jibeHost/);
  });
});
