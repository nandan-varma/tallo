import { prepareJob } from "@tallo/catalog";
import type { CollectContext, Http, Issue, Json, JsonObject, RawPosting } from "@tallo/contracts";
import { jobFactsSchema, obj } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { meta, platformFor, SchemaError } from "../src/index.ts";
import { PostingGone } from "../src/kit.ts";
import { drain, fixture, source, textFixture } from "./helpers.ts";

const BOOTSTRAP = `<html><body>
<script>require("LSD")</script>
<script type="application/json">{"require":[[["LSD",[],{"token":"tok-fixture"},1],["SiteData",[],{"server_revision":1,"haste_session":"hs-fixture","pr":1,"client_revision":1,"hsi":"hsi-fixture","comet_env":31,"__spin_r":1,"__spin_b":"trunk","__spin_t":1},1]]]}</script>
</body></html>`;

type Reply = { status?: number; text?: string; json?: Json };

interface FakeMeta {
  ctx: CollectContext;
  calls: { method: "get" | "post"; url: string }[];
  issues: Issue[];
}

/** Fake Http for the three surfaces Meta uses: the page token, the search POST and the job page. */
function metaCtx(reply: (url: string, method: "get" | "post") => Reply): FakeMeta {
  const calls: FakeMeta["calls"] = [];
  const issues: Issue[] = [];
  const call = (url: string, method: "get" | "post") => {
    calls.push({ method, url });
    const result = reply(url, method);
    const status = result.status ?? 200;
    if (status >= 300) {
      const error = new Error(`HTTP ${status}`) as Error & { status: number };
      error.status = status;
      throw error;
    }
    return { status, url, result };
  };
  const http: Http = {
    getJson: async (url) => {
      const { status, result } = call(url, "get");
      return { status, url, data: result.json ?? null };
    },
    postJson: async (url) => {
      const { status, result } = call(url, "post");
      return { status, url, data: result.json ?? null };
    },
    getText: async (url) => {
      const { status, result } = call(url, "get");
      return { status, url, data: result.text ?? "" };
    },
  };
  return {
    ctx: { http, maxPostings: 10_000, record: (issue) => issues.push(issue) },
    calls,
    issues,
  };
}

/** A handler that answers the token page, the search query, and the recorded job page. */
const recorded =
  (search: Json = fixture("meta-list")) =>
  (url: string, method: "get" | "post"): Reply => {
    if (url.endsWith("/jobsearch/")) return { text: BOOTSTRAP };
    if (method === "post" && url.includes("/api/graphql/")) return { json: search };
    if (url.includes("/profile/job_details/")) return { text: textFixture("meta-detail.html") };
    throw new Error(`unexpected URL: ${url}`);
  };

const searchVariables = (url: string): JsonObject =>
  JSON.parse(new URL(url).searchParams.get("variables") ?? "{}") as JsonObject;

const rowsOf = (value: Json): JsonObject[] =>
  (obj(obj(value).data).job_search_with_featured_jobs_v2 as JsonObject).all_jobs as JsonObject[];

describe("meta", () => {
  const src = source("meta", "meta");

  it("reads the public search token, then lists every job once", async () => {
    const { ctx, calls } = metaCtx(recorded());
    const { items, result } = await drain(meta.list(src, ctx));
    expect(calls.map((c) => c.method)).toEqual(["get", "post"]);
    expect(calls[0]?.url).toBe("https://www.metacareers.com/jobsearch/");
    expect(calls[1]?.url).toContain("doc_id=40084319704492118");
    expect(calls[1]?.url).toContain("lsd=tok-fixture");
    expect(searchVariables(calls[1]!.url)).toMatchObject({
      isLoggedIn: false,
      search_input: { teams: [] },
    });
    expect(items.map((item) => item.id)).toEqual([
      "2486789151677735",
      "1159789876480295",
      "1690022942358388",
    ]);
    expect(items[0]?.listing).toEqual(rowsOf(fixture("meta-list"))[0]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
  });

  it("keeps a software team scope and drops featured jobs outside it", async () => {
    const scoped = source("meta", "meta-software", { teams: "Software Engineering" });
    const all = rowsOf(fixture("meta-list"));
    const featured = obj(obj(obj(fixture("meta-list")).data).job_search_with_featured_jobs_v2)
      .featured_jobs as Json;
    const software = all[0];
    if (!software) throw new Error("fixture has no software row");
    const { ctx, calls } = metaCtx(
      recorded({
        data: {
          job_search_with_featured_jobs_v2: {
            all_jobs: [software],
            featured_jobs: featured,
          },
        },
      }),
    );
    const { items, result } = await drain(meta.list(scoped, ctx));
    expect(items.map((item) => item.id)).toEqual(["2486789151677735"]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: false });
    expect(searchVariables(calls[1]!.url)).toMatchObject({
      search_input: { teams: ["Software Engineering"] },
    });
  });

  it("rejects a scoped answer that contains jobs outside the team", async () => {
    const scoped = source("meta", "meta-software", { teams: "Software Engineering" });
    const all = rowsOf(fixture("meta-list"));
    const { ctx } = metaCtx(
      recorded({
        data: {
          job_search_with_featured_jobs_v2: { all_jobs: all, featured_jobs: [] },
        },
      }),
    );
    await expect(drain(meta.list(scoped, ctx))).rejects.toThrow(/outside the team scope/);
  });

  it("requires a distinct key for a scoped board", () => {
    expect(() => platformFor(source("meta", "meta", { teams: "Software Engineering" }))).toThrow(
      /distinct source key/,
    );
    expect(() => platformFor(source("meta", "meta-software", { teams: "" }))).toThrow(/empty/);
    expect(() =>
      platformFor(
        source("meta", "meta-software", { teams: "Software Engineering, software engineering" }),
      ),
    ).toThrow(/repeats/);
    expect(() => platformFor(source("meta", "meta", { team: "Software Engineering" }))).toThrow(
      /Unknown Meta param/,
    );
    expect(() => platformFor(source("meta", "meta/../x"))).toThrow(/Invalid/);
  });

  it("retries once with a fresh token when the search token is rejected", async () => {
    let searches = 0;
    const { ctx, calls } = metaCtx((url, method) => {
      if (url.endsWith("/jobsearch/")) return { text: BOOTSTRAP };
      if (method === "post") {
        searches++;
        return searches === 1 ? { status: 400 } : { json: fixture("meta-list") };
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const { items } = await drain(meta.list(src, ctx));
    expect(items).toHaveLength(3);
    expect(calls.filter((c) => c.method === "get")).toHaveLength(2);
    expect(calls.filter((c) => c.method === "post")).toHaveLength(2);
  });

  it("never claims completeness on malformed or repeated answers", async () => {
    const bad: Json[] = [
      {},
      { data: {} },
      { data: { job_search_with_featured_jobs_v2: {} } },
      { data: { job_search_with_featured_jobs_v2: { all_jobs: {}, featured_jobs: [] } } },
      { data: { job_search_with_featured_jobs_v2: { all_jobs: [{}], featured_jobs: [] } } },
      {
        data: {
          job_search_with_featured_jobs_v2: {
            all_jobs: [{ id: "1" }, { id: "1" }],
            featured_jobs: [],
          },
        },
      },
      {
        data: {
          job_search_with_featured_jobs_v2: {
            all_jobs: [],
            featured_jobs: [{ id: "2" }, { id: "2" }],
          },
        },
      },
      { errors: [{ message: "bad query" }], data: null },
    ];
    for (const answer of bad) {
      const { ctx } = metaCtx(recorded(answer));
      await expect(drain(meta.list(src, ctx))).rejects.toBeInstanceOf(SchemaError);
    }
  });

  it("rejects a token page without a public token", async () => {
    const { ctx } = metaCtx((url) =>
      url.endsWith("/jobsearch/") ? { text: "<html></html>" } : { json: fixture("meta-list") },
    );
    await expect(drain(meta.list(src, ctx))).rejects.toBeInstanceOf(SchemaError);
  });

  it("accepts an authoritatively empty board and flags a possible result cap", async () => {
    const empty = {
      data: { job_search_with_featured_jobs_v2: { all_jobs: [], featured_jobs: [] } },
    };
    const first = metaCtx(recorded(empty));
    expect(await drain(meta.list(src, first.ctx))).toEqual({
      items: [],
      result: { complete: true, emptyIsAuthoritative: true },
    });

    const capped = {
      data: {
        job_search_with_featured_jobs_v2: {
          all_jobs: Array.from({ length: 1000 }, (_, index) => ({
            id: String(index + 1),
            title: `Job ${index + 1}`,
            locations: ["Remote, US"],
            teams: [],
            sub_teams: [],
          })),
          featured_jobs: [],
        },
      },
    };
    const second = metaCtx(recorded(capped));
    const { result } = await drain(meta.list(src, second.ctx));
    expect(result.complete).toBe(false);
    expect(second.issues.map((issue) => issue.code)).toEqual(["pagination"]);
  });

  it("maps the job page's JSON-LD and preloaded structured detail", async () => {
    const { ctx } = metaCtx(recorded());
    const { items } = await drain(meta.list(src, ctx));
    const posting = items[0] as RawPosting;
    const detail = await meta.detail?.(src, posting, ctx);
    const job = meta.map({ ...posting, detail }, src);

    expect(job).toMatchObject({
      postingId: "2486789151677735",
      title: "Software Engineer, Infrastructure",
      url: "https://www.metacareers.com/profile/job_details/2486789151677735/",
      applyUrl: "https://www.metacareers.com/profile/job_details/2486789151677735/",
      workMode: "remote",
      department: "Software Engineering",
      team: "Engineering",
      employmentType: "FULL_TIME",
      requisitionId: "a1KDp00000E2ZEgMAN",
      postedAt: "2025-06-10T13:24:53-07:00",
    });
    expect(job.locations[0]).toEqual({
      text: "Sunnyvale, CA",
      city: "Sunnyvale",
      region: "California",
      country: "US",
      countryCode: "US",
      primary: true,
    });
    expect(job.locations).toHaveLength(12);
    expect(job.locations.filter((place) => place.primary)).toHaveLength(1);
    expect(job.compensation).toEqual([
      {
        min: 183997,
        max: 257000,
        currency: "USD",
        interval: "year",
        component: "base",
        region: "US",
        text: "$183,997/year - $257,000/year",
      },
    ]);
    expect(job.experience).toEqual([]);
    expect(job.extras).toMatchObject({
      teams: ["Software Engineering"],
      subTeams: ["Engineering"],
      departments: ["Software Engineering"],
      internalDepartments: ["Engineering"],
      jobLocationType: "TELECOMMUTE",
      applicantCountries: ["United States of America"],
      hasBonus: true,
      hasEquity: true,
    });
    expect(job.description).toContain("build innovative application experiences");
    expect(job.description).toContain("Responsibilities");
    expect(job.description).toContain("Minimum qualifications");

    const prepared = await prepareJob(job, src, "a".repeat(64));
    expect(jobFactsSchema.safeParse(prepared.facts).success).toBe(true);
  });

  it("maps a listing without a detail payload from its own locations", () => {
    const row = rowsOf(fixture("meta-list"))[0] as JsonObject;
    const job = meta.map({ id: itemId(row), listing: row }, src);
    expect(job.title).toBe("Software Engineer, Infrastructure");
    expect(job.description).toBe("");
    expect(job.locations).toHaveLength(12);
    expect(job.locations[0]).toEqual({ text: "Sunnyvale, CA", primary: true });
    expect(job.workMode).toBeUndefined();
    expect(job.compensation).toEqual([]);
  });

  it("treats a job page without its JSON-LD as a closed posting, not a broken board", async () => {
    const posting = {
      id: "2486789151677735",
      listing: rowsOf(fixture("meta-list"))[0],
    } as RawPosting;
    const { ctx } = metaCtx(() => ({ text: "<html></html>" }));
    await expect(meta.detail?.(src, posting, ctx)).rejects.toBeInstanceOf(PostingGone);
  });

  it("throws when a job page is broken or answers for another job", async () => {
    const posting = {
      id: "2486789151677735",
      listing: rowsOf(fixture("meta-list"))[0],
    } as RawPosting;
    const html = textFixture("meta-detail.html").replaceAll("2486789151677735", "1");
    const { ctx } = metaCtx(() => ({ text: html }));
    await expect(meta.detail?.(src, posting, ctx)).rejects.toBeInstanceOf(SchemaError);
    await expect(
      meta.detail?.(src, { id: "x", listing: {} }, metaCtx(recorded()).ctx),
    ).rejects.toBeInstanceOf(SchemaError);
  });
});

function itemId(row: JsonObject): string {
  const value = row.id;
  if (typeof value !== "string") throw new Error("fixture row has no id");
  return value;
}
