import { describe, expect, it } from "vitest";
import {
  deadSources,
  dueSources,
  formatDead,
  LOCAL_EGRESS_STALE_HOURS,
  localEgressSources,
  parseShard,
  type SourceState,
  shardOf,
} from "../src/due.ts";

const configured = [
  { id: "greenhouse:acme", platform: "greenhouse" },
  { id: "greenhouse:dead", platform: "greenhouse" },
  { id: "lever:zed", platform: "lever" },
];
const state = new Map<string, Pick<SourceState, "status" | "lastCompleteRunAt">>([
  ["greenhouse:acme", { status: "active", lastCompleteRunAt: 100 }],
  ["greenhouse:dead", { status: "dead", lastCompleteRunAt: 50 }],
  ["lever:zed", { status: "active", lastCompleteRunAt: null }],
]);
const ids = (list: { id: string }[]) => list.map((s) => s.id);

describe("dueSources", () => {
  it("skips excluded platforms, and excludes nothing by default", () => {
    const all = ids(dueSources(configured, state, { cutoff: 1000 }));
    expect(all).toContain("lever:zed");
    expect(
      ids(dueSources(configured, state, { cutoff: 1000, excludePlatforms: ["lever"] })),
    ).toEqual(["greenhouse:acme"]);
    expect(
      ids(
        dueSources(configured, state, { cutoff: 1000, excludePlatforms: ["lever", "greenhouse"] }),
      ),
    ).toEqual([]);
  });

  it("skips dead boards by default, oldest complete run first", () => {
    expect(ids(dueSources(configured, state, { cutoff: 1000 }))).toEqual([
      "lever:zed",
      "greenhouse:acme",
    ]);
  });

  it("includes dead boards only when asked", () => {
    expect(ids(dueSources(configured, state, { cutoff: 1000, includeDead: true }))).toEqual([
      "lever:zed",
      "greenhouse:dead",
      "greenhouse:acme",
    ]);
  });

  it("an explicit source still skips a dead board unless includeDead", () => {
    expect(dueSources(configured, state, { cutoff: 1000, source: "greenhouse:dead" })).toEqual([]);
    expect(
      ids(
        dueSources(configured, state, {
          cutoff: 1000,
          source: "greenhouse:dead",
          includeDead: true,
        }),
      ),
    ).toEqual(["greenhouse:dead"]);
  });

  it("an explicit source bypasses the staleness cutoff", () => {
    expect(ids(dueSources(configured, state, { cutoff: 0, source: "greenhouse:acme" }))).toEqual([
      "greenhouse:acme",
    ]);
  });

  it("a source with no state is active and due", () => {
    expect(
      ids(dueSources([{ id: "ashby:new", platform: "ashby" }], new Map(), { cutoff: 1 })),
    ).toEqual(["ashby:new"]);
  });

  it("filters by platform and limit", () => {
    expect(
      ids(
        dueSources(configured, state, { cutoff: 1000, includeDead: true, platform: "greenhouse" }),
      ),
    ).toEqual(["greenhouse:dead", "greenhouse:acme"]);
    expect(ids(dueSources(configured, state, { cutoff: 1000, limit: 1 }))).toEqual(["lever:zed"]);
  });
});

describe("deadSources and formatDead", () => {
  const row = (
    id: string,
    status: "active" | "dead",
    failures = 0,
    lastRunAt: number | null = null,
  ): SourceState => ({
    id,
    company: id.toUpperCase(),
    status,
    consecutiveFailures: failures,
    lastRunAt,
    lastCompleteRunAt: null,
  });

  it("lists only dead boards, sorted by id", () => {
    const rows = [row("lever:b", "dead", 3), row("lever:ok", "active"), row("ashby:a", "dead", 4)];
    expect(ids(deadSources(rows))).toEqual(["ashby:a", "lever:b"]);
  });

  it("formats one line per dead board, with the 404 count and last run", () => {
    const text = formatDead([row("ashby:a", "dead", 4, Date.UTC(2026, 9, 1) / 1000)]);
    expect(text).toContain("1 dead");
    expect(text).toContain("ashby:a\tASHBY:A\t404 x4\tlast run 2026-10-01");
  });

  it("says so when nothing is dead", () => {
    expect(formatDead([])).toBe("No dead boards.");
  });
});

describe("empty-board back-off", () => {
  const DAY = 86_400;
  const now = 1_000 * DAY;
  const board = { id: "ashby:empty", platform: "ashby" };
  const at = (days: number) => now - days * DAY;
  /** One board with its last complete run `sinceRun` seconds ago. */
  const state = (
    lastPostingsAt: number | null,
    sinceRun: number,
    lastStatus: string | null = "complete",
  ) =>
    new Map([
      [
        board.id,
        {
          status: "active" as const,
          lastCompleteRunAt: now - sinceRun,
          lastStatus,
          lastPostingsAt,
        },
      ],
    ]);
  const dueAt = (s: ReturnType<typeof state>, source?: string) =>
    dueSources([board], s, { cutoff: now - 3600, now, ...(source ? { source } : {}) });

  it("keeps a board with postings in the last week on the normal schedule", () => {
    expect(dueAt(state(at(1), DAY))).toEqual([board]);
  });

  it("runs a board empty for a week every three days", () => {
    expect(dueAt(state(at(10), 2 * DAY))).toEqual([]);
    expect(dueAt(state(at(10), 3 * DAY))).toEqual([board]);
  });

  it("runs a board empty for a month, or never listed, weekly", () => {
    expect(dueAt(state(at(40), 6 * DAY))).toEqual([]);
    expect(dueAt(state(null, 6 * DAY))).toEqual([]);
    expect(dueAt(state(null, 7 * DAY))).toEqual([board]);
  });

  it("never backs off a board whose last run was partial, so failing boards keep daily retries", () => {
    expect(dueAt(state(at(40), DAY, "partial"))).toEqual([board]);
    expect(dueAt(state(at(40), DAY, null))).toEqual([board]);
  });

  it("an explicit source bypasses the back-off", () => {
    expect(dueAt(state(at(40), DAY), board.id)).toEqual([board]);
  });
});

describe("localEgressSources", () => {
  const boards: { id: string; platform: string; params: Record<string, string> }[] = [
    { id: "workday:abb", platform: "workday", params: { wd: "wd3", egress: "local" } },
    { id: "workday:plain", platform: "workday", params: { wd: "wd1" } },
    { id: "greenhouse:acme", platform: "greenhouse", params: {} },
    { id: "workday:other", platform: "workday", params: { wd: "wd5", egress: "cloud" } },
  ];

  it("keeps only boards with params.egress set to local", () => {
    expect(ids(localEgressSources(boards))).toEqual(["workday:abb"]);
  });

  it("is empty when no board needs the Mac's egress", () => {
    expect(localEgressSources(boards.slice(1))).toEqual([]);
  });

  it("feeds dueSources: only local boards are due, on the weekly cutoff", () => {
    const now = 10_000_000;
    const state = new Map<string, Pick<SourceState, "status" | "lastCompleteRunAt">>([
      ["workday:abb", { status: "active", lastCompleteRunAt: now - 3 * 86_400 }],
    ]);
    const cutoff = now - LOCAL_EGRESS_STALE_HOURS * 3600;
    // Completed 3 days ago: inside the weekly window, so not due yet.
    expect(dueSources(localEgressSources(boards), state, { cutoff, now })).toEqual([]);
    // Completed 8 days ago: due.
    state.set("workday:abb", { status: "active", lastCompleteRunAt: now - 8 * 86_400 });
    expect(ids(dueSources(localEgressSources(boards), state, { cutoff, now }))).toEqual([
      "workday:abb",
    ]);
  });

  it("never selects a cloud board, even when it is due", () => {
    expect(ids(dueSources(localEgressSources(boards), new Map(), { cutoff: 1 }))).toEqual([
      "workday:abb",
    ]);
  });
});

describe("shards", () => {
  it("parses i/n and refuses anything else", () => {
    expect(parseShard("3/16")).toEqual({ index: 3, count: 16 });
    expect(parseShard("0/1")).toEqual({ index: 0, count: 1 });
    for (const bad of ["16/16", "1", "a/b", "1/0", "-1/4"])
      expect(typeof parseShard(bad)).toBe("string");
  });

  it("puts every board in exactly one shard, the same one every time", () => {
    const ids = Array.from({ length: 500 }, (_, i) => `workday:tenant${i}/site`);
    const count = 7;
    const slices = Array.from({ length: count }, (_, index) =>
      dueSources(
        ids.map((id) => ({ id, platform: "workday" })),
        new Map(),
        { cutoff: 1, shard: { index, count } },
      ).map((s) => s.id),
    );
    expect(slices.flat().sort()).toEqual([...ids].sort());
    for (const slice of slices) expect(slice.length).toBeGreaterThan(30);
    expect(shardOf("workday:a/b", count)).toBe(shardOf("workday:a/b", count));
  });
});
