import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Two files describe the API Worker: cloudflare.config.ts is what `cf deploy` ships (the Worker was created through
// that flow and cannot go back to `wrangler deploy`), wrangler.jsonc serves local development and `wrangler d1`.
// They must agree on everything that changes behavior, so a switch flipped in one cannot hide in the other.
const wrangler = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
) as {
  routes: { pattern: string }[];
  triggers: { crons: string[] };
  queues: { consumers: { max_concurrency: number; max_retries: number }[] };
  vars: Record<string, string>;
};
const cf = readFileSync(new URL("../cloudflare.config.ts", import.meta.url), "utf8");

const cfVars = Object.fromEntries(
  [...cf.matchAll(/(\w+): bindings\.text\("([^"]*)"\)/g)].map((m) => [m[1], m[2]]),
);

describe("API Worker config", () => {
  it("sets the same variables in both files", () => {
    expect(cfVars).toEqual(wrangler.vars);
  });

  it("refuses public reads on the API's own custom domain", () => {
    const host = wrangler.vars.READS_BLOCKED_HOST;
    expect(host).toBe("tallo-api.nandan.fyi");
    expect(wrangler.routes.map((r) => r.pattern)).toContain(host);
  });

  // `scheduled` tells the two jobs apart by the cron string (`COLLECT_CRON` in src/index.ts).
  it("runs the collect tick and the hourly housekeeping in both files", () => {
    expect(wrangler.triggers.crons).toEqual(["*/5 * * * *", "17 * * * *"]);
    const crons = [...cf.matchAll(/schedule: "([^"]+)"/g)].map((m) => m[1]);
    expect(crons).toEqual(wrangler.triggers.crons);
  });

  it("gives the queue consumer the same limits in both files", () => {
    const [consumer] = wrangler.queues.consumers;
    expect(cf).toContain(`maxConcurrency: ${consumer?.max_concurrency}`);
    expect(cf).toContain(`maxRetries: ${consumer?.max_retries}`);
  });
});
