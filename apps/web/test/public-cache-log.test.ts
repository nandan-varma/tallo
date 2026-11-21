import { encodeCursor, NEGATIVE_CACHE_CONTROL, PUBLIC_COST_HEADER } from "@tallo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  answer,
  type EdgeCache,
  handlePublic,
  offsetBucket,
  type PublicDeps,
  type PublicLogLine,
} from "@/lib/public";

const ORIGIN = "https://tallo.nandan.fyi";
const get = (path: string) => new Request(`${ORIGIN}${path}`);

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

const COST = { statements: 2, rows_read: 40, rows_written: 0, rows_returned: 25 };

const apiAnswer = () =>
  Response.json(
    { results: [], next: null },
    {
      headers: {
        "cache-control": "public, max-age=60, s-maxage=300",
        [PUBLIC_COST_HEADER]: JSON.stringify(COST),
      },
    },
  );

function withLog(over: Partial<PublicDeps> = {}) {
  const lines: PublicLogLine[] = [];
  const upstream = vi.fn(async (_pathAndQuery: string) => apiAnswer());
  const deps: PublicDeps = { upstream, cache: memoryCache(), log: (l) => lines.push(l), ...over };
  return { lines, upstream, deps };
}

describe("stable negative answers at the edge", () => {
  it("stores a closed posting for its TTL, so a repeat ask does not reach the API", async () => {
    const cache = memoryCache();
    const upstream = vi.fn(async () =>
      Response.json(
        { error: { code: "closed", message: "", hint: "" } },
        { status: 410, headers: { "cache-control": NEGATIVE_CACHE_CONTROL.closed } },
      ),
    );
    const deps: PublicDeps = { upstream, cache };

    expect((await handlePublic(get("/v1/jobs/77"), deps)).status).toBe(410);
    const repeat = await handlePublic(get("/v1/jobs/77"), deps);

    expect(repeat.status).toBe(410);
    expect(repeat.headers.get("cache-control")).toBe(NEGATIVE_CACHE_CONTROL.closed);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("stores an unknown id for an hour", async () => {
    const cache = memoryCache();
    const upstream = vi.fn(async () =>
      Response.json(
        { error: { code: "unknown", message: "", hint: "" } },
        { status: 404, headers: { "cache-control": NEGATIVE_CACHE_CONTROL.unknown } },
      ),
    );
    const deps: PublicDeps = { upstream, cache };
    await handlePublic(get("/v1/jobs/999"), deps);
    await handlePublic(get("/v1/jobs/999"), deps);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(cache.store.size).toBe(1);
  });

  it("does not store a 404 the API did not mark public, nor any parameter error", async () => {
    const cache = memoryCache();
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "description_missing" } },
          {
            status: 404,
            headers: { "cache-control": "no-store" },
          },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "invalid_parameter" } },
          {
            status: 400,
            headers: { "cache-control": "public, max-age=3600" },
          },
        ),
      );
    const deps: PublicDeps = { upstream, cache };
    await handlePublic(get("/v1/jobs/1/description"), deps);
    await handlePublic(get("/v1/jobs/1/description?offset=-1"), deps);
    expect(cache.store.size).toBe(0);
  });

  it("keeps the TTL the API set on a stored negative answer", async () => {
    const cache = memoryCache();
    const upstream = vi.fn(async () =>
      Response.json(
        { error: { code: "closed" } },
        {
          status: 410,
          headers: { "cache-control": NEGATIVE_CACHE_CONTROL.closed },
        },
      ),
    );
    await answer("/v1/jobs/5", { upstream, cache });
    const stored = cache.store.get("https://tallo.nandan.fyi/v1/jobs/5");
    expect(stored?.headers.get("cache-control")).toBe(NEGATIVE_CACHE_CONTROL.closed);
  });
});

describe("the cost header", () => {
  it("is read for the log and never returned to the caller", async () => {
    const { deps } = withLog();
    const response = await handlePublic(get("/v1/search?title=engineer"), deps);
    expect(response.headers.has(PUBLIC_COST_HEADER)).toBe(false);
  });

  it("is not stored with the answer, so a cache hit does not repeat an old origin's cost", async () => {
    const { deps } = withLog();
    await handlePublic(get("/v1/search?title=engineer"), deps);
    const stored = [...(deps.cache as ReturnType<typeof memoryCache>).store.values()][0];
    expect(stored?.headers.has(PUBLIC_COST_HEADER)).toBe(false);
  });
});

describe("one log line per public request", () => {
  it("records a miss with the origin's cost, then a hit with none", async () => {
    const { lines, deps } = withLog();

    await handlePublic(get("/v1/search?title=engineer"), deps);
    await handlePublic(get("/v1/search?title=engineer"), deps);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      event: "public_request",
      route: "/v1/search",
      status: 200,
      cache: "miss",
      offset: "0",
      statements: 2,
      rows_read: 40,
      rows_written: 0,
      rows_returned: 25,
    });
    expect(lines[1]).toMatchObject({
      route: "/v1/search",
      cache: "hit",
      statements: 0,
      rows_read: 0,
      rows_returned: 0,
    });
    expect(lines[0]?.ms).toEqual(expect.any(Number));
  });

  it("names the offset bucket from the cursor, and never logs the cursor itself", async () => {
    const { lines, deps } = withLog();
    const query = {
      title: ["engineer"],
      company: [],
      location: [],
      country: [],
      sort: "relevance" as const,
    };
    const cursor = encodeCursor(query, 30);
    await handlePublic(get(`/v1/search?title=engineer&cursor=${cursor}`), deps);

    expect(lines[0]?.offset).toBe("25-99");
    expect(JSON.stringify(lines[0])).not.toContain(cursor);
  });

  it("logs rejected requests too, with no cache and no database figures", async () => {
    const { lines, upstream, deps } = withLog();
    const response = await handlePublic(get("/v1/jobs"), deps);

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
    expect(lines).toEqual([
      expect.objectContaining({
        route: "none",
        status: 404,
        cache: "none",
        offset: null,
        statements: null,
        rows_read: null,
      }),
    ]);
  });

  it("logs a search the results page asks for, as a request of its own", async () => {
    const { lines, deps } = withLog();
    await answer("/v1/search?title=engineer", deps);
    expect(lines.map((l) => l.route)).toEqual(["/v1/search"]);
  });

  it("reports unknown figures as null when the API sent no cost header", async () => {
    const { lines, deps } = withLog({ upstream: vi.fn(async () => Response.json({})) });
    await handlePublic(get("/v1/jobs/1"), deps);
    expect(lines[0]).toMatchObject({ statements: null, rows_read: null, rows_returned: null });
  });

  it("writes nothing when no log is bound", async () => {
    const deps: PublicDeps = { upstream: vi.fn(async () => apiAnswer()) };
    const response = await handlePublic(get("/v1/search?title=engineer"), deps);
    expect(response.status).toBe(200);
  });
});

describe("offsetBucket", () => {
  it("puts each offset in one bucket, at the edges too", () => {
    expect([0, 1, 24, 25, 99, 100, 299].map(offsetBucket)).toEqual([
      "0",
      "1-24",
      "1-24",
      "25-99",
      "25-99",
      "100-299",
      "100-299",
    ]);
  });
});
