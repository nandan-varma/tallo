import { readFileSync } from "node:fs";
import { inThreadCpu } from "@tallo/collect";
import type { RawPosting, SourceConfig } from "@tallo/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { createCpuPool } from "../src/pool.ts";

const fx = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/platforms/test/fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const source: SourceConfig = {
  id: "greenhouse:stripe",
  platform: "greenhouse",
  key: "stripe",
  company: "Stripe",
  params: {},
};
const listing = fx("greenhouse-list").jobs[0];
const posting: RawPosting = { id: String(listing.id), listing, detail: fx("greenhouse-detail") };

const pool = createCpuPool(2);
afterAll(() => pool.close());

describe("cpu pool", () => {
  it("hashes exactly as the in-thread default does", async () => {
    const listings = [listing, { ...listing, title: "Other" }];
    const hashes = await pool.hashes(source, listings);
    expect(hashes).toEqual(await inThreadCpu.hashes(source, listings));
    expect(new Set(hashes).size).toBe(2);
  });

  it("prepares exactly as the in-thread default does", async () => {
    const viaPool = await pool.prepare(source, posting, "h1");
    const inThread = await inThreadCpu.prepare(source, posting, "h1");
    expect(viaPool.facts).toEqual(inThread.facts);
    expect(viaPool.line).toBe(inThread.line);
    expect(Array.from(viaPool.jd)).toEqual(Array.from(inThread.jd));
  });

  it("handles many requests at once", async () => {
    const out = await Promise.all(
      Array.from({ length: 40 }, (_, i) => pool.prepare(source, posting, `h${i}`)),
    );
    expect(out.map((o) => o.facts.sourceHash)).toEqual(out.map((_, i) => `h${i}`));
  });

  it("rejects with the worker's error message", async () => {
    const untitled = { ...posting, listing: { ...listing, title: "" }, detail: { title: "" } };
    await expect(pool.prepare(source, untitled, "h")).rejects.toThrow("Posting has no title");
  });

  it("keeps working in this thread once its workers are gone", async () => {
    const small = createCpuPool(1);
    await small.close();
    expect(await small.hashes(source, [listing])).toEqual(
      await inThreadCpu.hashes(source, [listing]),
    );
  });
});
