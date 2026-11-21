import { PUBLIC_PATHS } from "@tallo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  admit,
  type EdgeCache,
  handlePublic,
  isPublicPath,
  type Limiter,
  normalizedPathAndQuery,
  type PublicDeps,
} from "@/lib/public";

const ORIGIN = "https://tallo.nandan.fyi";
const get = (path: string, init?: RequestInit & { headers?: Record<string, string> }) =>
  new Request(`${ORIGIN}${path}`, init);

const OK_BODY = { results: [], next: null, note: "No open postings match." };
const okApi = () =>
  Response.json(OK_BODY, { headers: { "cache-control": "public, max-age=60, s-maxage=300" } });

/** A Map-backed stand-in for caches.default: keeps responses by URL. */
function memoryCache(): EdgeCache & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    async match(request) {
      return store.get(request.url)?.clone();
    },
    async put(request, response) {
      store.set(request.url, response);
    },
  };
}

function deps(over: Partial<PublicDeps> = {}) {
  const upstream = vi.fn(async (_pathAndQuery: string) => okApi());
  const built: PublicDeps = { upstream, ...over };
  return { upstream, deps: built };
}

const allowLimiter: Limiter = { limit: vi.fn(async () => ({ success: true })) };
const denyLimiter: Limiter = { limit: vi.fn(async () => ({ success: false })) };

describe("the allowlist", () => {
  it("serves exactly the documented public paths", () => {
    for (const path of [
      "/v1/search",
      "/v1/jobs/1",
      "/v1/jobs/123456/description",
      "/v1/jobs/9999999999999999/description",
    ]) {
      expect(isPublicPath(path), path).toBe(true);
    }
    for (const path of [
      "/v1/jobs",
      "/v1/jobs/search",
      "/v1/jobs/0",
      "/v1/jobs/01",
      "/v1/jobs/abc",
      "/v1/jobs/1/description/extra",
      "/v1/jobs/1/",
      "/v1/search/",
      "/v1/searchX",
      "/v1/admin/collect",
      "/v1/admin/sources",
      "/v1/runs",
      "/v1/sources",
      "/v1/sources/status",
      "/v1/blobs/jd/abc",
      "/v1/applications",
      "/health",
      "/llms.txt",
    ]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it("derives from the shared path list, so each documented template has a matching example", () => {
    const examples = ["/v1/search", "/v1/jobs/42", "/v1/jobs/42/description"];
    expect(PUBLIC_PATHS).toHaveLength(examples.length);
    for (const example of examples) expect(isPublicPath(example)).toBe(true);
  });

  it("answers 404 for an admin or ingest path, and never calls the API", async () => {
    const { upstream, deps: d } = deps();
    for (const [method, path] of [
      ["GET", "/v1/admin/collect/status"],
      ["POST", "/v1/admin/collect"],
      ["POST", "/v1/runs"],
      ["GET", "/v1/sources/status"],
      ["PUT", "/v1/blobs/jd/abc"],
    ] as const) {
      const response = await handlePublic(get(path, { method }), d);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 405 for any method but GET on a public path", async () => {
    const { upstream, deps: d } = deps();
    const response = await handlePublic(get("/v1/search?title=ab", { method: "POST" }), d);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("request limits", () => {
  it("answers 414 for a path and query over 2048 characters, before the limiter or the API", async () => {
    const { upstream, deps: d } = deps({ limiter: allowLimiter });
    const response = await handlePublic(get(`/v1/search?title=ab&location=${"x".repeat(2100)}`), d);
    expect(response.status).toBe(414);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "uri_too_long",
    );
    expect(allowLimiter.limit).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After when the address is over budget, and does not call the API", async () => {
    const { upstream, deps: d } = deps({ limiter: denyLimiter });
    const response = await handlePublic(
      get("/v1/search?title=ab", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
      d,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(denyLimiter.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keys the limit on the address, and fails open when no limiter is bound", async () => {
    const limiter: Limiter = { limit: vi.fn(async () => ({ success: true })) };
    expect(
      await admit(get("/v1/search", { headers: { "cf-connecting-ip": "198.51.100.2" } }), limiter),
    ).toBe(true);
    expect(limiter.limit).toHaveBeenCalledWith({ key: "198.51.100.2" });
    expect(await admit(get("/v1/search"), undefined)).toBe(true);
  });
});

describe("forwarding and the edge cache", () => {
  it("forwards the query in sorted order, so one question has one URL", async () => {
    const { upstream, deps: d } = deps();
    await handlePublic(get("/v1/search?title=b&limit=10&title=a"), d);
    expect(upstream).toHaveBeenCalledWith("/v1/search?limit=10&title=a&title=b");
    expect(normalizedPathAndQuery(new URL(`${ORIGIN}/v1/search?title=b&limit=10&title=a`))).toBe(
      "/v1/search?limit=10&title=a&title=b",
    );
  });

  it("answers a repeat question from the edge cache, whatever the parameter order", async () => {
    const cache = memoryCache();
    const { upstream, deps: d } = deps({ cache });
    const first = await handlePublic(get("/v1/search?title=ab&title=cd&limit=5"), d);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(OK_BODY);

    const second = await handlePublic(get("/v1/search?limit=5&title=cd&title=ab"), d);
    expect(second.status).toBe(200);
    expect(second.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=300");
    expect(await second.json()).toEqual(OK_BODY);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("does not cache an answer that is not a 200", async () => {
    const cache = memoryCache();
    const upstream = vi.fn(async () =>
      Response.json({ error: { code: "not_found", message: "", hint: "" } }, { status: 404 }),
    );
    const d: PublicDeps = { upstream, cache };
    expect((await handlePublic(get("/v1/jobs/77"), d)).status).toBe(404);
    expect((await handlePublic(get("/v1/jobs/77"), d)).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(cache.store.size).toBe(0);
  });

  it("still answers when the cache store fails", async () => {
    const cache: EdgeCache = {
      match: async () => undefined,
      put: async () => {
        throw new Error("cache down");
      },
    };
    const { deps: d } = deps({ cache });
    const response = await handlePublic(get("/v1/search?title=ab"), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OK_BODY);
  });

  it("counts every request against the address, cached or not", async () => {
    const cache = memoryCache();
    const limiter: Limiter = { limit: vi.fn(async () => ({ success: true })) };
    const { deps: d } = deps({ cache, limiter });
    await handlePublic(get("/v1/search?title=ab"), d);
    await handlePublic(get("/v1/search?title=ab"), d);
    // Every request counts against the address, cached or not: the budget is about requests, not database reads.
    expect(limiter.limit).toHaveBeenCalledTimes(2);
  });
});
