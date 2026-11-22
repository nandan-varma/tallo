// @vitest-environment jsdom
import type { SiteStats } from "@tallo/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusPage } from "@/components/StatusPage";
import type { EdgeCache } from "@/lib/public";
import { loadSiteStats } from "@/lib/site-stats";
import { expectNoViolations } from "./a11y";

afterEach(cleanup);

const NOW = 1_800_000_000;
const stats: SiteStats = {
  asOf: NOW - 3600,
  catalogAsOf: NOW - 7200,
  collectedTotal: 1_900_000,
  openJobs: 612_345,
  employers: 8_100,
  boards: 8_791,
  platforms: 18,
  freshness: {
    listed7d: 8_000,
    listed14d: 8_700,
    newestRunAt: NOW - 120,
    added24h: 4_000,
    added7d: 31_000,
    closed7d: 27_000,
  },
  byPlatform: [
    { platform: "greenhouse", boards: 4000, open: 300_000 },
    { platform: "lever", boards: 900, open: 40_000 },
  ],
  topEmployers: [{ name: "Acme", open: 12_000 }],
  countries: { distinct: 80, top: [{ code: "US", share: 0.4 }] },
  mix: {
    remote: 0.05,
    hybrid: 0.1,
    onsite: 0.2,
    unstated: 0.65,
    payStated: 0.12,
    postedStated: 0.99,
    countryStated: 0.73,
  },
  health: { failing: 12, dead: 40 },
  history: [
    { day: NOW - 2 * 86400, openJobs: 600_000, added: 3_000 },
    { day: NOW - 86400, openJobs: 612_345, added: 4_000 },
  ],
};

describe("StatusPage", () => {
  it("shows grouped real numbers, the as-of stamp, unknowns and links", async () => {
    const { container } = render(<StatusPage stats={stats} now={NOW} />);

    expect(screen.getAllByText("612,345").length).toBeGreaterThan(0);
    expect(screen.getAllByText("8,000 of 8,791 boards")).toBeTruthy();
    expect(screen.getByText(/Health as of/)).toBeTruthy();
    expect(screen.getByText("1,900,000")).toBeTruthy();
    expect(screen.getByText(/Last collection run/)).toBeTruthy();
    expect(screen.getByText(/sweeps are run by hand|a sweep is under way/)).toBeTruthy();
    expect(screen.getByRole("table", { name: "Open jobs per day" })).toBeTruthy();
    expect(screen.getByText("Not stated by the source")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Open jobs by platform" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "OpenAPI (JSON)" }).getAttribute("href")).toBe(
      "/v1/openapi.json",
    );
    expect(screen.queryByText(/latency/i)).toBeNull();
    await expectNoViolations(container);
  });

  it("shows a plain message when the snapshot is unavailable", async () => {
    const { container } = render(<StatusPage stats={null} now={NOW} />);
    expect(screen.getByRole("status").textContent).toContain("not available");
    expect(screen.getByRole("link", { name: "llms.txt" })).toBeTruthy();
    await expectNoViolations(container);
  });

  it("handles an empty catalog", async () => {
    const empty: SiteStats = {
      ...stats,
      openJobs: 0,
      boards: 0,
      byPlatform: [],
      topEmployers: [],
      countries: { distinct: 0, top: [] },
      freshness: { ...stats.freshness, newestRunAt: null },
      history: [],
    };
    const { container } = render(<StatusPage stats={empty} now={NOW} />);
    expect(screen.getByText("none yet")).toBeTruthy();
    await expectNoViolations(container);
  });
});

function memoryCache(): EdgeCache {
  const store = new Map<string, Response>();
  return {
    async match(request) {
      return store.get(request.url)?.clone();
    },
    async put(request, response) {
      store.set(request.url, response);
    },
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body));

describe("loadSiteStats", () => {
  it("asks the API once and then serves the cached snapshot", async () => {
    const cache = memoryCache();
    const upstream = vi.fn(async () => json(stats));
    const now = () => stats.asOf + 60;

    expect(await loadSiteStats({ upstream, cache, now })).toEqual(stats);
    expect(await loadSiteStats({ upstream, cache, now })).toEqual(stats);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("refreshes after five minutes, and serves the stale snapshot when the API is down", async () => {
    const cache = memoryCache();
    await loadSiteStats({ upstream: async () => json(stats), cache, now: () => stats.asOf });
    const later = () => stats.asOf + 600;

    const down = vi.fn(async () => new Response("no", { status: 502 }));
    expect(await loadSiteStats({ upstream: down, cache, now: later })).toEqual(stats);
    expect(down).toHaveBeenCalledTimes(1);

    const throws = async () => {
      throw new Error("offline");
    };
    expect(await loadSiteStats({ upstream: throws, cache: memoryCache(), now: later })).toBeNull();
  });
});
