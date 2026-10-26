import { describe, expect, it } from "vitest";
import { deadSources, dueSources, formatDead, type SourceState } from "../src/due.ts";

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
