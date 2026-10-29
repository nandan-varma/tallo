import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryBlobs, obsoleteRunQueries, pruneRuns, rawKey, schema } from "../src/index.ts";
import { testDb } from "../src/testing.ts";

const DAY = 86400;
const T = 2_000_000_000;
let db: ReturnType<typeof testDb>;
let blobs: ReturnType<typeof memoryBlobs>;

beforeEach(() => {
  db = testDb();
  blobs = memoryBlobs();
});

async function queryPlan(query: { getSQL(): ReturnType<typeof sql> }): Promise<string> {
  const rows = await db.all<unknown[]>(sql`EXPLAIN QUERY PLAN ${query.getSQL()}`);
  return rows.map((r) => String(r.at(-1))).join("\n");
}

async function packRun(id: string, sourceId: string, startedAt: number, status = "complete") {
  const key = rawKey(sourceId, id);
  await db.insert(schema.runs).values({
    id,
    sourceId,
    runnerId: "mac",
    collectorVersion: "t",
    startedAt,
    status: status as "complete",
    rawKey: key,
  });
  await blobs.put(key, new Uint8Array([1]));
}

describe("run retention plans", () => {
  it("finds aged runs through runs_started_idx, not a scan of runs", async () => {
    const [aged] = obsoleteRunQueries(db, T);
    const details = await queryPlan(aged);
    expect(details).toContain("runs_started_idx");
    expect(details).not.toMatch(/SCAN runs(?! USING)/);
  });

  it("finds superseded packs through runs_pack_idx, not a scan of runs", async () => {
    const [, superseded] = obsoleteRunQueries(db, T);
    const details = await queryPlan(superseded);
    expect(details).toContain("runs_pack_idx");
    expect(details).not.toMatch(/SCAN runs(?! USING)/);
  });

  it("finds expired history through runs_started_idx", async () => {
    const details = await queryPlan(
      db
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(sql`${schema.runs.startedAt} < ${T - 30 * DAY} AND ${schema.runs.rawKey} IS NULL`),
    );
    expect(details).toContain("runs_started_idx");
    expect(details).not.toMatch(/SCAN runs(?! USING)/);
  });
});

describe("run retention with many runs", () => {
  it("prunes the same packs as before when most runs carry no pack", async () => {
    // Three sources, two packs each kept, one superseded pack per source, plus many pack-less runs.
    for (const source of ["a", "b", "c"]) {
      await packRun(`${source}-old`, source, T - 3 * DAY);
      await packRun(`${source}-mid`, source, T - 2 * DAY);
      await packRun(`${source}-new`, source, T - DAY);
    }
    for (let i = 0; i < 200; i++) {
      await db.insert(schema.runs).values({
        id: `bare-${i}`,
        sourceId: "a",
        runnerId: "mac",
        collectorVersion: "t",
        startedAt: T - (i + 1) * 60,
        status: "complete",
      });
    }
    expect(await pruneRuns(db, blobs, T)).toEqual({ packs: 3, runs: 0 });
    expect(blobs.keys().sort()).toEqual(
      ["a-mid", "a-new", "b-mid", "b-new", "c-mid", "c-new"]
        .map((id) => rawKey(id[0] ?? "", id))
        .sort(),
    );
    expect(await pruneRuns(db, blobs, T)).toEqual({ packs: 0, runs: 0 });
  });

  it("deletes expired pack-less history and keeps recent pack-less runs", async () => {
    for (let i = 0; i < 50; i++) {
      await db.insert(schema.runs).values({
        id: `old-${i}`,
        sourceId: "a",
        runnerId: "mac",
        collectorVersion: "t",
        startedAt: T - 31 * DAY - i,
        status: "complete",
      });
      await db.insert(schema.runs).values({
        id: `recent-${i}`,
        sourceId: "a",
        runnerId: "mac",
        collectorVersion: "t",
        startedAt: T - DAY - i,
        status: "complete",
      });
    }
    expect(await pruneRuns(db, blobs, T)).toEqual({ packs: 0, runs: 50 });
    expect(await db.select().from(schema.runs)).toHaveLength(50);
  });
});
