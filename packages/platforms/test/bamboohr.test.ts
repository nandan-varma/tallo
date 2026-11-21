import type { Json } from "@tallo/contracts";
import { obj } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { bamboohr, platformFor, SchemaError } from "../src/index.ts";
import { drain, fakeCtx, fixture, source } from "./helpers.ts";

describe("bamboohr", () => {
  const src = source("bamboohr", "cardinal");
  it("lists the single unpaged answer and maps list plus detail", async () => {
    const { ctx, urls } = fakeCtx(() => fixture("bamboohr-list"));
    const { items, result } = await drain(bamboohr.list(src, ctx));
    expect(urls).toEqual(["https://cardinal.bamboohr.com/careers/list"]);
    expect(items.map((i) => i.id)).toEqual(["48", "53"]);
    expect(result).toEqual({ complete: true, emptyIsAuthoritative: true });
    const job = bamboohr.map({ ...items[0]!, detail: obj(fixture("bamboohr-detail")).result }, src);
    expect(job.title).toBe("Offshore Cook");
    expect(job.url).toBe("https://cardinal.bamboohr.com/careers/48");
    expect(job.department).toBe("Culinary Offshore");
    expect(job.postedAt).toBe("2025-06-27");
    expect(job.locations[0]).toMatchObject({ city: "Alvin", region: "Texas", primary: true });
    expect(job.description).toContain("offshore");
    // Pay is free text ("$14.50 and up DOE"): kept as stated, never typed.
    expect(job.compensation).toEqual([]);
    expect(job.extras).toMatchObject({ compensationText: "$14.50 and up DOE" });
  });
  it("maps a listing without detail", async () => {
    const { ctx } = fakeCtx(() => fixture("bamboohr-list"));
    const { items } = await drain(bamboohr.list(src, ctx));
    const job = bamboohr.map(items[1]!, src);
    expect(job.title).toBeTruthy();
    expect(job.description).toBe("");
  });
  it("reports an incomplete listing when the count disagrees", async () => {
    const list = obj(fixture("bamboohr-list"));
    const { ctx } = fakeCtx(() => ({ ...list, meta: { totalCount: 5 } }));
    const { result } = await drain(bamboohr.list(src, ctx));
    expect(result.complete).toBe(false);
  });
  it("accepts an existing board with no openings", async () => {
    const { ctx } = fakeCtx(() => ({ meta: { totalCount: 0 }, result: [] }));
    const { items, result } = await drain(bamboohr.list(src, ctx));
    expect(items).toHaveLength(0);
    expect(result.emptyIsAuthoritative).toBe(true);
  });
  it("throws SchemaError on unexpected shapes", async () => {
    for (const bad of [{}, { result: {} }, { result: [] }, "<html></html>"] as Json[]) {
      const { ctx } = fakeCtx(() => bad);
      await expect(drain(bamboohr.list(src, ctx))).rejects.toBeInstanceOf(SchemaError);
    }
  });
  it("rejects keys that are not a bare subdomain", () => {
    expect(() => platformFor(source("bamboohr", "evil.com/x"))).toThrow(/Invalid/);
  });
});
