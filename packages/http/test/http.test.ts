import { describe, expect, it, vi } from "vitest";
import { createHttp, hostAllowed, HttpError } from "../src/index.ts";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers });

function make(fetchImpl: typeof fetch, extra = {}) {
  return createHttp({ fetch: fetchImpl, allowedHosts: ["api.example.com", "*.cdn.test"], retryDelay: () => 0, ...extra });
}

describe("hostAllowed", () => {
  it("matches exact and wildcard hosts", () => {
    expect(hostAllowed("api.example.com", ["api.example.com"])).toBe(true);
    expect(hostAllowed("a.cdn.test", ["*.cdn.test"])).toBe(true);
    expect(hostAllowed("cdn.test", ["*.cdn.test"])).toBe(false);
    expect(hostAllowed("evil.com", ["api.example.com"])).toBe(false);
  });
});

describe("createHttp", () => {
  it("parses JSON and retries 5xx then succeeds", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ ok: 1 }));
    const res = await make(f).getJson("https://api.example.com/x");
    expect(res.data).toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not retry 404 and surfaces the status", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(json({}, 404));
    await expect(make(f).getJson("https://api.example.com/x")).rejects.toMatchObject({ status: 404 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("returns okStatuses as data", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "none" }, 404));
    const res = await make(f).getJson("https://api.example.com/x", { okStatuses: [404] });
    expect(res.status).toBe(404);
  });

  it("blocks disallowed hosts, http, and private addresses without fetching", async () => {
    const f = vi.fn<typeof fetch>();
    const http = make(f);
    for (const url of ["https://evil.com/", "http://api.example.com/", "https://127.0.0.1/", "https://localhost/"]) {
      await expect(http.getJson(url)).rejects.toMatchObject({ kind: "blocked" });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("re-checks redirect targets against the allowlist", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://evil.com/" } }));
    await expect(make(f).getJson("https://api.example.com/x")).rejects.toBeInstanceOf(HttpError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized and non-JSON bodies", async () => {
    const big = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(100)));
    await expect(make(big, { maxResponseBytes: 10 }).getText("https://api.example.com/")).rejects.toMatchObject({ kind: "blocked" });
    const bad = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>"));
    await expect(make(bad).getJson("https://api.example.com/")).rejects.toMatchObject({ kind: "schema" });
  });

  it("gives up after maxRetries on network failure", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("boom"));
    await expect(make(f, { maxRetries: 2 }).getJson("https://api.example.com/")).rejects.toMatchObject({ kind: "network" });
    expect(f).toHaveBeenCalledTimes(3);
  });
});
