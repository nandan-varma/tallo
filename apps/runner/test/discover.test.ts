import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boardOfUrl, discover, writeAccepted } from "../src/discover.ts";

describe("boardOfUrl", () => {
  it("finds the platform and key in careers URLs", () => {
    expect(boardOfUrl("https://ats.rippling.com/en-GB/boom-supersonic/jobs/abc")).toEqual({
      platform: "rippling",
      key: "boom-supersonic",
      params: {},
    });
    expect(boardOfUrl("https://jobs.gem.com/-joinforage/abc")?.key).toBe("-joinforage");
    expect(boardOfUrl("https://caribou.breezy.hr/p/123-job")).toMatchObject({
      platform: "breezy",
      key: "caribou",
    });
    expect(boardOfUrl("https://boards.eu.greenhouse.io/acme/jobs/1")).toEqual({
      platform: "greenhouse",
      key: "acme",
      params: { region: "eu" },
    });
  });

  it("ignores other sites and the vendors' own subdomains", () => {
    expect(boardOfUrl("https://example.com/careers")).toBeUndefined();
    expect(boardOfUrl("https://www.pinpointhq.com/customers")).toBeUndefined();
  });
});

describe("discover", () => {
  const clean = { issues: [], warnings: [] };

  it("verifies new boards once, skips configured ones, and reports rejects", async () => {
    const checked: string[] = [];
    const found = await discover(
      [
        "https://jobs.gem.com/aviary/x",
        "https://jobs.gem.com/aviary/y",
        "https://jobs.gem.com/old",
        "https://jobs.gem.com/empty",
        "https://jobs.gem.com/noisy",
        "https://example.com/careers",
      ],
      ["gem:old"],
      async (source) => {
        checked.push(source.id);
        if (source.key === "empty") return { listed: 0, ...clean };
        if (source.key === "noisy") return { listed: 2, issues: [], warnings: ["x: no url"] };
        return { listed: 3, ...clean };
      },
    );
    expect(checked).toEqual(["gem:aviary", "gem:empty", "gem:noisy"]);
    expect(found.accepted.map((s) => [s.id, s.company])).toEqual([["gem:aviary", "Aviary"]]);
    expect(found.rejected).toEqual([
      { id: "gem:empty", reason: "no postings" },
      { id: "gem:noisy", reason: "x: no url" },
    ]);
    expect(found.known).toBe(1);
    expect(found.unrecognized).toEqual(["https://example.com/careers"]);
  });
});

describe("writeAccepted", () => {
  it("adds boards to the platform file in key order", () => {
    const dir = mkdtempSync(join(tmpdir(), "tallo-sources-"));
    writeFileSync(join(dir, "gem.json"), JSON.stringify([{ key: "b", company: "B" }]));
    writeAccepted(dir, [
      { id: "gem:a", platform: "gem", key: "a", company: "A", params: {} },
      { id: "gem:c", platform: "gem", key: "c", company: "C", params: {} },
    ]);
    const keys = (JSON.parse(readFileSync(join(dir, "gem.json"), "utf8")) as { key: string }[]).map(
      (e) => e.key,
    );
    expect(keys).toEqual(["a", "b", "c"]);
  });
});
