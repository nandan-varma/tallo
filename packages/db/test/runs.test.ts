import { beforeEach, describe, expect, it } from "vitest";
import { finalize, listRuns, startRun } from "../src/index.ts";
import { testDb } from "../src/testing.ts";

const source = {
  id: "greenhouse:acme",
  platform: "greenhouse",
  key: "acme",
  company: "Acme Corp",
  params: {},
};
const T = 1_800_000_000;
let db: ReturnType<typeof testDb>;

const run = async (runId: string, startedAt: number) => {
  await startRun(
    db,
    { runId, source, runnerId: "mac", collectorVersion: "t", startedAt },
    startedAt,
  );
  return runId;
};

const finish = (runId: string, over: Partial<Parameters<typeof finalize>[2]>) =>
  finalize(db, runId, {
    seenIds: [],
    listingComplete: true,
    detailsComplete: true,
    // An empty listing that is not vouched for is not a clean run; these fixtures are clean ones.
    emptyIsAuthoritative: true,
    requests: 1,
    finishedAt: T + 10,
    rawKey: null,
    issues: [],
    boardNotFound: false,
    ...over,
  });

beforeEach(() => {
  db = testDb();
});

describe("listRuns", () => {
  it("returns newest first and can narrow to runs that need attention", async () => {
    await run("run-clean-0001", T);
    await finish("run-clean-0001", {});
    await run("run-partial-01", T + 100);
    await finish("run-partial-01", {
      listingComplete: false,
      issues: [{ code: "http", message: "HTTP 503 on board" }],
    });
    await run("run-issues-001", T + 200);
    await finish("run-issues-001", {
      issues: [{ code: "detail", message: "detail 404", postingId: "7" }],
    });

    const all = await listRuns(db, { limit: 50, attention: false });
    expect(all.map((r) => r.id)).toEqual(["run-issues-001", "run-partial-01", "run-clean-0001"]);

    const attention = await listRuns(db, { limit: 50, attention: true });
    expect(attention.map((r) => r.id)).toEqual(["run-issues-001", "run-partial-01"]);
    expect(attention[1]).toMatchObject({ status: "partial", sourceId: "greenhouse:acme" });
  });
});

describe("startRun claim", () => {
  it("supersedes a run past the two-hour lease", async () => {
    await run("run-stale-0001", T);
    await run("run-fresh-0001", T + 2 * 60 * 60 + 1);
    expect((await listRuns(db, { limit: 50, attention: false })).length).toBe(2);
  });
});
