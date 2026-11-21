import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wrangler = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
) as {
  routes: { pattern: string }[];
  triggers: { crons: string[] };
  vars: Record<string, string>;
};

// The public reads are refused on the API's own host, so the web Worker is the only way in. If the host named here
// stopped being the API's custom domain, the guard would block nothing.
describe("READS_BLOCKED_HOST", () => {
  it("is the API's custom domain", () => {
    const host = wrangler.vars.READS_BLOCKED_HOST;
    expect(host).toBe("tallo-api.nandan.fyi");
    expect(wrangler.routes.map((r) => r.pattern)).toContain(host);
  });
});

// `scheduled` tells the two jobs apart by the cron string (`COLLECT_CRON` in src/index.ts): the five-minute tick
// enqueues due boards, any other tick is housekeeping.
describe("cron triggers", () => {
  it("has the collect tick and the hourly housekeeping", () => {
    expect(wrangler.triggers.crons).toEqual(["*/5 * * * *", "17 * * * *"]);
  });
});
