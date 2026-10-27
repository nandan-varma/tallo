import { readFileSync } from "node:fs";
import { createApp } from "@tallo/api/app";
import { memoryBlobs } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";
import { syncSource } from "../src/sync.ts";
import { verifySource } from "../src/verify.ts";

const fx = (name: string) =>
  readFileSync(
    new URL(`../../../packages/platforms/test/fixtures/${name}.json`, import.meta.url),
    "utf8",
  );
const source = {
  id: "greenhouse:stripe",
  platform: "greenhouse",
  key: "stripe",
  company: "Stripe",
  params: {},
};
const log = pino({ level: "silent" });

/** Fake Greenhouse: list from fixture, details from the pay-transparency fixture. */
function greenhouse(overrides: { listing?: () => Response } = {}): typeof fetch {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/jobs"))
      return overrides.listing?.() ?? new Response(fx("greenhouse-list"));
    return new Response(fx("greenhouse-detail"));
  };
}

function stack() {
  const db = testDb();
  const blobs = memoryBlobs();
  const app = createApp({ db, blobs, readToken: "r", ingestToken: "i" });
  const api = createApi("https://api.test", "i", async (req) =>
    app.fetch(req instanceof Request ? req : new Request(req)),
  );
  return { db, blobs, app, api };
}
// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in tests
const read = async (app: ReturnType<typeof stack>["app"], path: string): Promise<any> =>
  (await app.request(path, { headers: { authorization: "Bearer r" } })).json();

describe("syncSource end to end", () => {
  it("lists, fetches details, uploads, and the catalog serves the result", async () => {
    const { app, api, blobs } = stack();
    const result = await syncSource(source, {
      api,
      log,
      runnerId: "test",
      version: "t",
      fetch: greenhouse(),
    });
    expect(result).toMatchObject({ listingComplete: true, detailsComplete: true, changed: 2 });
    expect(blobs.keys().filter((k) => k.startsWith("jd/")).length).toBeGreaterThan(0);
    expect(blobs.keys().some((k) => k.startsWith("raw/greenhouse:stripe/"))).toBe(true);
    // The fixture's two listings are one posting in two locations (same title and JD): one card,
    // both listings kept as variants.
    const { jobs } = await read(app, "/v1/jobs?q=revenue");
    expect(jobs).toHaveLength(1);
    const detail = await read(app, `/v1/jobs/${jobs[0].id}`);
    expect(detail.variants).toHaveLength(2);
    expect(detail.description.length).toBeGreaterThan(100);
    expect(detail.company).toBe("Stripe");
  });

  it("a second run with nothing changed fetches no details and writes no jobs", async () => {
    const { api } = stack();
    await syncSource(source, { api, log, runnerId: "test", version: "t", fetch: greenhouse() });
    let detailCalls = 0;
    const counting: typeof fetch = async (input, init) => {
      if (!new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/jobs"))
        detailCalls++;
      return greenhouse()(input, init);
    };
    const again = await syncSource(source, {
      api,
      log,
      runnerId: "test",
      version: "t",
      fetch: counting,
    });
    expect(again).toMatchObject({ changed: 0, listingComplete: true });
    expect(detailCalls).toBe(0);
  });

  it("a failed listing is recorded and never closes anything", async () => {
    const { app, api } = stack();
    await syncSource(source, { api, log, runnerId: "test", version: "t", fetch: greenhouse() });
    const broken = greenhouse({ listing: () => new Response("{}", { status: 500 }) });
    for (let i = 0; i < 3; i++) {
      const failed = await syncSource(source, {
        api,
        log,
        runnerId: "test",
        version: "t",
        fetch: broken,
      });
      expect(failed.listingComplete).toBe(false);
    }
    expect((await read(app, "/v1/jobs?q=revenue")).jobs).toHaveLength(1);
    const [row] = await read(app, "/v1/sources");
    expect(row).toMatchObject({ id: source.id, lastStatus: "partial" });
  });

  it("a failing detail skips that posting and reports it without failing the listing", async () => {
    const { app, api } = stack();
    const flaky: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.pathname.endsWith("/jobs")
        ? greenhouse()(input, init)
        : new Response("nope", { status: 404 });
    };
    const result = await syncSource(source, {
      api,
      log,
      runnerId: "test",
      version: "t",
      fetch: flaky,
    });
    expect(result).toMatchObject({ listingComplete: true, detailsComplete: false });
    expect(result.issues.some((i) => i.code === "detail")).toBe(true);
    expect((await read(app, "/v1/jobs?q=revenue")).jobs).toHaveLength(0);
  });
});

describe("verifySource", () => {
  it("reports quality and the source fields the mapper never reads", async () => {
    const report = await verifySource(source, 2, greenhouse());
    expect(report).toMatchObject({ listed: 2, sampled: 2, warnings: [] });
    expect(report.presence.compensation).toBe("present");
    expect(report.unmapped.some((p) => p.includes("data_compliance"))).toBe(true);
    expect(report.unmapped).not.toContain("listing.title");
  });
});

describe("dead boards", () => {
  const gone = () => greenhouse({ listing: () => new Response("", { status: 404 }) });
  const sourceRow = async (app: ReturnType<typeof stack>["app"]) =>
    (await read(app, "/v1/sources")).find((s: { id: string }) => s.id === source.id);

  it("a 404 listing is reported as board-not-found, and three in a row mark it dead", async () => {
    const { app, api } = stack();
    await syncSource(source, { api, log, runnerId: "test", version: "t", fetch: greenhouse() });
    for (let i = 0; i < 2; i++) {
      const result = await syncSource(source, {
        api,
        log,
        runnerId: "test",
        version: "t",
        fetch: gone(),
      });
      expect(result).toMatchObject({ listingComplete: false, boardNotFound: true });
    }
    expect(await sourceRow(app)).toMatchObject({ status: "active", consecutiveFailures: 2 });
    await syncSource(source, { api, log, runnerId: "test", version: "t", fetch: gone() });
    expect(await sourceRow(app)).toMatchObject({ status: "dead", consecutiveFailures: 3 });
    // The catalog is untouched: a dead board closes nothing.
    expect((await read(app, "/v1/jobs?q=revenue")).jobs).toHaveLength(1);
  });

  it("a 404 on a later page of a real board is a failed run, not board-not-found", async () => {
    const { app, api } = stack();
    // SmartRecruiters pages by 100: the board answers page one, then 404s on page two.
    const page = (offset: number) =>
      offset === 0
        ? new Response(
            JSON.stringify({
              totalFound: 150,
              content: Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: "Job" })),
            }),
          )
        : new Response("", { status: 404 });
    const paged: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return page(Number(url.searchParams.get("offset")));
    };
    const smart = {
      id: "smartrecruiters:acme",
      platform: "smartrecruiters",
      key: "acme",
      company: "Acme",
      params: {},
    };
    const result = await syncSource(smart, {
      api,
      log,
      runnerId: "test",
      version: "t",
      fetch: paged,
    });
    expect(result).toMatchObject({ listingComplete: false, boardNotFound: false });
    const [row] = (await read(app, "/v1/sources")).filter((s: { id: string }) => s.id === smart.id);
    expect(row).toMatchObject({ status: "active", consecutiveFailures: 0 });
  });

  it("a retired Workday tenant that redirects off the allowlist is board-not-found, and goes dead", async () => {
    const { app, api } = stack();
    const workday = {
      id: "workday:acme",
      platform: "workday",
      key: "acme/careers",
      company: "Acme",
      params: { wd: "wd5" },
    };
    const retired: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://community.workday.com/retired" },
      });
    for (let i = 0; i < 3; i++) {
      const result = await syncSource(workday, {
        api,
        log,
        runnerId: "test",
        version: "t",
        fetch: retired,
      });
      expect(result).toMatchObject({ listingComplete: false, boardNotFound: true });
    }
    const [row] = (await read(app, "/v1/sources")).filter(
      (s: { id: string }) => s.id === workday.id,
    );
    expect(row).toMatchObject({ status: "dead", consecutiveFailures: 3 });
  });

  it("a failure between two 404s does not reset the streak", async () => {
    const { app, api } = stack();
    // 403 is not retried, so this stays fast; it says nothing about whether the board exists.
    const forbidden = greenhouse({ listing: () => new Response("", { status: 403 }) });
    await syncSource(source, { api, log, runnerId: "test", version: "t", fetch: gone() });
    await syncSource(source, { api, log, runnerId: "test", version: "t", fetch: gone() });
    const result = await syncSource(source, {
      api,
      log,
      runnerId: "test",
      version: "t",
      fetch: forbidden,
    });
    expect(result.boardNotFound).toBe(false);
    expect(await sourceRow(app)).toMatchObject({ status: "active", consecutiveFailures: 2 });
    await syncSource(source, { api, log, runnerId: "test", version: "t", fetch: gone() });
    expect(await sourceRow(app)).toMatchObject({ status: "dead", consecutiveFailures: 3 });
  });

  it("a 500 is a failed run, not a 404, and does not count toward dead", async () => {
    const { app, api } = stack();
    const broken = greenhouse({ listing: () => new Response("{}", { status: 500 }) });
    const result = await syncSource(source, {
      api,
      log,
      runnerId: "test",
      version: "t",
      fetch: broken,
    });
    expect(result.boardNotFound).toBe(false);
    expect(await sourceRow(app)).toMatchObject({ status: "active", consecutiveFailures: 0 });
  });
});
