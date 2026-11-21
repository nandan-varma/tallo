import { describe, expect, it, vi } from "vitest";
import { backoffMs, createHttp, HttpError, hostAllowed } from "../src/index.ts";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers });

function make(fetchImpl: typeof fetch, extra = {}) {
  return createHttp({
    fetch: fetchImpl,
    allowedHosts: ["api.example.com", "*.cdn.test"],
    retryDelay: () => 0,
    ...extra,
  });
}

describe("hostAllowed", () => {
  it("matches exact and wildcard hosts", () => {
    expect(hostAllowed("api.example.com", ["api.example.com"])).toBe(true);
    expect(hostAllowed("a.cdn.test", ["*.cdn.test"])).toBe(true);
    expect(hostAllowed("cdn.test", ["*.cdn.test"])).toBe(false);
    expect(hostAllowed("evil.com", ["api.example.com"])).toBe(false);
  });
});

describe("backoffMs", () => {
  it("doubles from one second and never sleeps less than half the slot", () => {
    expect(backoffMs(1, () => 0)).toBe(500);
    expect(backoffMs(2, () => 0)).toBe(1000);
    expect(backoffMs(3, () => 0)).toBe(2000);
    expect(backoffMs(3, () => 1)).toBeCloseTo(4000);
  });

  it("caps the slot at 30 seconds", () => {
    expect(backoffMs(20, () => 1)).toBeCloseTo(30_000);
    expect(backoffMs(20, () => 0)).toBe(15_000);
  });
});

describe("conditional requests", () => {
  const notModified = () => new Response(null, { status: 304, headers: { etag: 'W/"v1"' } });

  it("passes headers through and reports the ETag of a 200", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push(
        new Headers(init?.headers).get("if-none-match") ??
          (input as Request).headers?.get("if-none-match"),
      );
      return json({ ok: true }, 200, { etag: 'W/"v1"' });
    };
    const res = await make(fetchImpl).getJson("https://api.example.com/x", {
      headers: { "if-none-match": 'W/"v0"' },
      okStatuses: [304],
    });
    expect(seen).toEqual(['W/"v0"']);
    expect(res).toMatchObject({ status: 200, data: { ok: true }, etag: 'W/"v1"' });
  });

  it("returns a 304 as a response, not a redirect, when the caller allows it", async () => {
    const fetchImpl = vi.fn(async () => notModified());
    const res = await make(fetchImpl as unknown as typeof fetch).getJson(
      "https://api.example.com/x",
      {
        okStatuses: [304],
      },
    );
    expect(res).toMatchObject({ status: 304, data: null, etag: 'W/"v1"' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still treats a 304 as an error when the caller did not ask for it", async () => {
    const fetchImpl = (async () => notModified()) as unknown as typeof fetch;
    await expect(make(fetchImpl).getJson("https://api.example.com/x")).rejects.toBeInstanceOf(
      HttpError,
    );
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
    await expect(make(f).getJson("https://api.example.com/x")).rejects.toMatchObject({
      status: 404,
    });
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
    for (const url of [
      "https://evil.com/",
      "http://api.example.com/",
      "https://127.0.0.1/",
      "https://localhost/",
    ]) {
      await expect(http.getJson(url)).rejects.toMatchObject({ kind: "blocked" });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("re-checks redirect targets against the allowlist", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://evil.com/" } }),
      );
    await expect(make(f).getJson("https://api.example.com/x")).rejects.toBeInstanceOf(HttpError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("reports a redirect off the allowlist as its own kind, without fetching the target", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: "https://community.workday.com/gone" },
      }),
    );
    await expect(make(f).getJson("https://api.example.com/x")).rejects.toMatchObject({
      kind: "redirect",
      status: 301,
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries a request that timed out, then succeeds", async () => {
    const f = vi.fn<typeof fetch>().mockImplementationOnce(
      (input) =>
        new Promise((_resolve, reject) => {
          (input as Request).signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    f.mockResolvedValueOnce(json({ ok: 1 }));
    const res = await make(f, { timeoutMs: 10 }).getJson("https://api.example.com/x");
    expect(res.data).toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized and non-JSON bodies", async () => {
    const big = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(100)));
    await expect(
      make(big, { maxResponseBytes: 10 }).getText("https://api.example.com/"),
    ).rejects.toMatchObject({ kind: "blocked" });
    const bad = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>"));
    await expect(make(bad).getJson("https://api.example.com/")).rejects.toMatchObject({
      kind: "schema",
    });
  });

  it("waits out a 429 Retry-After longer than 30 seconds before retrying", async () => {
    vi.useFakeTimers();
    try {
      const f = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({}, 429, { "retry-after": "45" }))
        .mockResolvedValueOnce(json({ ok: 1 }));
      const pending = make(f, { retryDelay: undefined }).getJson("https://api.example.com/x");
      await vi.advanceTimersByTimeAsync(44_000);
      expect(f).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await pending).data).toEqual({ ok: 1 });
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after maxRetries on network failure", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("boom"));
    await expect(
      make(f, { maxRetries: 2 }).getJson("https://api.example.com/"),
    ).rejects.toMatchObject({ kind: "network" });
    expect(f).toHaveBeenCalledTimes(3);
  });
});
