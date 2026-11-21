import { prepareJob, slug } from "@tallo/catalog";
import type { JobFacts, MappedJob, SourceConfig } from "@tallo/contracts";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { applyJobs, jdKey, memoryBlobs, schema, startRun } from "../src/index.ts";
import { testDb } from "../src/testing.ts";

const T = Math.floor(Date.now() / 1000);
let db: ReturnType<typeof testDb>;
let blobs: ReturnType<typeof memoryBlobs>;
let n = 0;

const sourceOf = (company: string, key: string): SourceConfig => ({
  id: `greenhouse:${key}`,
  platform: "greenhouse",
  key,
  company,
  params: {},
});
const mapped = (postingId: string): MappedJob => ({
  postingId,
  title: `Engineer ${postingId}`,
  description: `Build ${postingId}`,
  locations: [{ text: "Tokyo", primary: true }],
  compensation: [],
  experience: [],
  extras: {},
});
const start = async (source: SourceConfig) => {
  const runId = `run-${String(++n).padStart(6, "0")}`;
  await startRun(db, { runId, source, runnerId: "w", collectorVersion: "t", startedAt: T }, T);
  return runId;
};
const prepared = async (source: SourceConfig, ids: string[]) => {
  const out = await Promise.all(ids.map((id) => prepareJob(mapped(id), source, "a".repeat(64))));
  for (const p of out) await blobs.put(jdKey(p.facts.jdHash), p.jd);
  return out.map((p) => p.facts);
};

beforeEach(() => {
  db = testDb();
  blobs = memoryBlobs();
});

describe("applyJobs without the wire schema (Worker path)", () => {
  const source = sourceOf("Acme", "acme");

  it("bounds oversize fields per posting instead of failing the batch", async () => {
    const runId = await start(source);
    const [good, bad] = (await prepared(source, ["good", "bad"])) as [JobFacts, JobFacts];
    const long = {
      ...bad,
      title: "T".repeat(800),
      url: "u".repeat(5000),
      department: "d".repeat(500),
      facts: {
        ...bad.facts,
        locations: Array.from({ length: 400 }, (_, i) => ({ text: `L${i}` })),
      },
    };
    const result = await applyJobs(db, blobs, runId, [good, long], T);
    expect(result.applied).toBe(2);
    expect(result.invalid).toEqual([]);
    expect(result.bounded).toHaveLength(1);
    expect(result.bounded[0]!.postingId).toBe("bad");
    const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.sourceId, source.id));
    const row = rows.find((r) => r.postingId === "bad")!;
    expect(row.title).toHaveLength(500);
    expect(row.url).toBeNull();
    expect(row.department).toBeNull();
    expect((row.facts as { locations: unknown[] }).locations).toHaveLength(100);
    expect(rows).toHaveLength(2);
  });

  it("skips a posting whose id cannot be stored and reports it, writing the others", async () => {
    const runId = await start(source);
    const [good] = (await prepared(source, ["good"])) as [JobFacts];
    const result = await applyJobs(
      db,
      blobs,
      runId,
      [good, { ...good, postingId: "p".repeat(600) }],
      T,
    );
    expect(result.applied).toBe(1);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]!.postingId).toHaveLength(100);
  });
});

describe("non-Latin company slugs", () => {
  it("keep separate companies, jobs and sources apart", async () => {
    const a = sourceOf("株式会社テスト", "jp-a");
    const b = sourceOf("株式会社サンプル", "jp-b");
    const c = sourceOf("®©", "marks");
    for (const s of [a, b, c])
      await applyJobs(db, blobs, await start(s), await prepared(s, ["1"]), T);
    const slugs = (await db.select().from(schema.jobs)).map((j) => j.companySlug).sort();
    expect(new Set(slugs).size).toBe(3);
    expect(slugs).not.toContain("");
    expect(slugs).toContain(slug("株式会社テスト"));
    const companyRows = (await db.select().from(schema.companies)).map((r) => r.slug).sort();
    expect(companyRows).toEqual(slugs);
  });
});
