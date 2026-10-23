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
    const { jobs } = await read(app, "/v1/jobs?all=true");
    expect(jobs).toHaveLength(2);
    const detail = await read(app, `/v1/jobs/${jobs[0].id}`);
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
    expect((await read(app, "/v1/jobs?all=true")).jobs).toHaveLength(2);
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
    expect((await read(app, "/v1/jobs?all=true")).jobs).toHaveLength(0);
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
