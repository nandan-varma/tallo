import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The blocked host is set in two places (wrangler.jsonc, read by `wrangler`, and cloudflare.config.ts, read by `cf`).
// They must agree, and it must be the API's public custom domain, or the guard would block nothing.
describe("READS_BLOCKED_HOST", () => {
  const wrangler = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as {
    routes: { pattern: string }[];
    vars: Record<string, string>;
  };
  const cfConfig = readFileSync(new URL("../cloudflare.config.ts", import.meta.url), "utf8");

  it("is set in wrangler.jsonc to the API's custom domain", () => {
    const host = wrangler.vars.READS_BLOCKED_HOST;
    expect(host).toBe("tallo-api.nandan.fyi");
    expect(wrangler.routes.map((r) => r.pattern)).toContain(host);
  });

  it("is set to the same value in cloudflare.config.ts", () => {
    const match = /READS_BLOCKED_HOST:\s*bindings\.text\("([^"]+)"\)/.exec(cfConfig);
    expect(match?.[1]).toBe(wrangler.vars.READS_BLOCKED_HOST);
  });
});
