import { describe, expect, it } from "vitest";
import {
  attentionSources,
  httpsUrl,
  type RunRecord,
  runCounts,
  type SourceRecord,
  summarizeByPlatform,
  summarizeSources,
} from "../src/lib/status.ts";

const NOW = 1_800_000_000;
const DAY = 86400;

const source = (over: Partial<SourceRecord> = {}): SourceRecord => ({
  id: "greenhouse:acme",
  platform: "greenhouse",
  company: "Acme",
  key: "acme",
  lastRunAt: NOW - 3600,
  lastCompleteRunAt: NOW - 3600,
  lastListedAt: NOW - 3600,
  lastStatus: "complete",
  freshness: "fresh",
  ...over,
});

describe("summarizeSources", () => {
  it("separates never-collected sources and finds the latest collection", () => {
    const summary = summarizeSources([
      source({ id: "a", lastRunAt: NOW - 100 }),
      source({ id: "b", freshness: "stale", lastRunAt: NOW - 8 * DAY }),
      source({ id: "c", freshness: "hidden", lastRunAt: NOW - 20 * DAY }),
      source({
        id: "d",
        lastRunAt: null,
        lastListedAt: null,
        freshness: "hidden",
        lastStatus: null,
      }),
    ]);
    expect(summary).toEqual({
      total: 4,
      neverCollected: 1,
      fresh: 1,
      stale: 1,
      hidden: 1,
      lastCollectedAt: NOW - 100,
    });
  });

  it("reports no collection time when nothing has run", () => {
    expect(summarizeSources([]).lastCollectedAt).toBeNull();
  });
});

describe("summarizeByPlatform", () => {
  it("groups by platform in name order", () => {
    const rows = summarizeByPlatform([
      source({ id: "b", platform: "lever", lastRunAt: NOW - 10 }),
      source({ id: "a", platform: "ashby", freshness: "stale", lastRunAt: NOW - 8 * DAY }),
      source({
        id: "c",
        platform: "ashby",
        lastRunAt: null,
        lastListedAt: null,
        freshness: "hidden",
      }),
    ]);
    expect(rows.map((r) => r.platform)).toEqual(["ashby", "lever"]);
    expect(rows[0]).toMatchObject({
      total: 2,
      neverCollected: 1,
      stale: 1,
      lastCollectedAt: NOW - 8 * DAY,
    });
    expect(rows[1]).toMatchObject({ total: 1, fresh: 1 });
  });
});

describe("attentionSources", () => {
  it("lists collected sources that are stale, hidden or partial, oldest listing first", () => {
    const result = attentionSources([
      source({ id: "fine" }),
      source({ id: "never", lastRunAt: null, lastListedAt: null, freshness: "hidden" }),
      source({ id: "newer-stale", freshness: "stale", lastListedAt: NOW - 8 * DAY }),
      source({ id: "oldest-hidden", freshness: "hidden", lastListedAt: NOW - 30 * DAY }),
      source({ id: "partial", lastStatus: "partial" }),
    ]);
    expect(result.total).toBe(3);
    expect(result.sources.map((s) => s.id)).toEqual(["oldest-hidden", "newer-stale", "partial"]);
  });

  it("caps the list but keeps the true total", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      source({ id: `s${i}`, freshness: "stale", lastListedAt: NOW - (8 + i) * DAY }),
    );
    const result = attentionSources(many, 2);
    expect(result.total).toBe(5);
    expect(result.sources).toHaveLength(2);
  });
});

describe("runCounts", () => {
  const run = (over: Partial<RunRecord> = {}): RunRecord => ({
    id: "r",
    sourceId: "greenhouse:acme",
    runnerId: "mac",
    startedAt: NOW,
    finishedAt: NOW,
    status: "complete",
    seen: 10,
    added: 2,
    changed: 1,
    closed: null,
    issues: null,
    ...over,
  });

  it("omits counts that were not measured", () => {
    expect(runCounts(run())).toEqual([
      { label: "seen", value: 10 },
      { label: "added", value: 2 },
      { label: "changed", value: 1 },
    ]);
  });

  it("keeps zero, which is a measured value", () => {
    expect(runCounts(run({ seen: 0, closed: 0 })).map((c) => c.label)).toEqual([
      "seen",
      "added",
      "changed",
      "closed",
    ]);
  });
});

describe("httpsUrl", () => {
  it("keeps only absolute https URLs", () => {
    expect(httpsUrl("https://boards.example.com/jobs/1")).toBe("https://boards.example.com/jobs/1");
    expect(httpsUrl("http://example.com")).toBeUndefined();
    expect(httpsUrl("javascript:alert(1)")).toBeUndefined();
    expect(httpsUrl("/relative/path")).toBeUndefined();
    expect(httpsUrl("")).toBeUndefined();
    expect(httpsUrl(undefined)).toBeUndefined();
  });
});
