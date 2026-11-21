import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: { API_URL: "http://api.test", API: undefined, PUBLIC_LIMIT: undefined },
}));

import { encodeCursor } from "@tallo/contracts";
import { runSearch } from "@/lib/api";
import { handlePublic } from "@/lib/public";
import { offsetFrom, safeHref, searchHref, specFrom, splitList, valuesFrom } from "@/lib/search";

describe("splitList", () => {
  it("splits on commas, trims, drops entries shorter than two characters, and caps the count", () => {
    expect(splitList(" backend engineer , x, platform engineer ,", 8, 80)).toEqual([
      "backend engineer",
      "platform engineer",
    ]);
    expect(splitList("a1,b2,c3", 2, 80)).toEqual(["a1", "b2"]);
  });

  it("cuts each entry to the character limit", () => {
    expect(splitList("abcdefgh", 8, 4)).toEqual(["abcd"]);
  });
});

describe("specFrom", () => {
  it("is null without a title or a company to search for", () => {
    expect(specFrom({ title: " , ", company: " , ", location: "Seattle" })).toBeNull();
  });

  it("searches a company without inventing a title", () => {
    expect(specFrom({ title: "", company: "Stripe", location: "" })).toEqual({
      queries: [],
      companies: ["Stripe"],
    });
  });

  it("builds a spec from the title, and leaves out empty company and place lists", () => {
    expect(specFrom({ title: "data engineer", company: "", location: "" })).toEqual({
      queries: ["data engineer"],
    });
  });

  it("adds companies and places when they were typed", () => {
    expect(
      specFrom({ title: "data engineer", company: "Stripe, Airbnb", location: "Seattle, remote" }),
    ).toEqual({
      queries: ["data engineer"],
      companies: ["Stripe", "Airbnb"],
      locations: ["Seattle", "remote"],
    });
  });
});

describe("valuesFrom and offsetFrom", () => {
  it("reads the three fields, trimmed of nothing and capped in length", () => {
    const params = new URLSearchParams({ title: "x".repeat(400), company: "Stripe" });
    expect(valuesFrom(params)).toEqual({ title: "x".repeat(300), company: "Stripe", location: "" });
  });

  it("reads the offset as a whole number clamped to the results cap", () => {
    expect(offsetFrom(new URLSearchParams("offset=40"))).toBe(40);
    expect(offsetFrom(new URLSearchParams("offset=-5"))).toBe(0);
    expect(offsetFrom(new URLSearchParams("offset=abc"))).toBe(0);
    expect(offsetFrom(new URLSearchParams("offset=99999"))).toBe(299);
    expect(offsetFrom(new URLSearchParams())).toBe(0);
  });
});

describe("searchHref", () => {
  it("leaves out empty fields and the first page", () => {
    expect(searchHref({ title: "data engineer", company: "", location: "" })).toBe(
      "/search?title=data+engineer",
    );
    expect(searchHref({ title: "", company: "", location: "" })).toBe("/search");
  });

  it("carries the offset of a later page", () => {
    expect(searchHref({ title: "data engineer", company: "", location: "Seattle" }, 20)).toBe(
      "/search?title=data+engineer&location=Seattle&offset=20",
    );
  });
});

describe("safeHref", () => {
  it("passes web links only", () => {
    expect(safeHref("https://boards.example.com/apply/1")).toBe(
      "https://boards.example.com/apply/1",
    );
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});

describe("runSearch", () => {
  afterEach(() => vi.unstubAllGlobals());

  const apiPage = (results: unknown[], next: string | null) =>
    Response.json({
      apiVersion: "2",
      results,
      count: results.length,
      next,
      hasMore: next !== null,
      capped: false,
      expandedLocations: [],
      remote: false,
      asOf: "2026-11-21T00:00:00.000Z",
      note: "",
    });

  it("asks the API for one page of results without any token", async () => {
    const fetchMock = vi.fn(async () => apiPage([], null));
    vi.stubGlobal("fetch", fetchMock);

    const page = await runSearch({ queries: ["data engineer"], locations: ["remote"] }, 0);

    expect(page).toMatchObject({ hits: [], nextOffset: null, count: 0, hasMore: false });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe("http://api.test/v1/search?limit=20&location=remote&title=data+engineer");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("puts a cursor for the page on the URL, built for this query, and reads the next offset", async () => {
    const hit = { id: "1", title: "Data Engineer" };
    const fetchMock = vi.fn(async () =>
      apiPage(
        Array.from({ length: 20 }, () => hit),
        "next",
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = await runSearch({ queries: ["data engineer"] }, 20);

    expect(page.nextOffset).toBe(40);
    expect(page.hits).toHaveLength(20);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    const cursor = encodeCursor(
      { title: ["data engineer"], company: [], location: [], country: [], sort: "relevance" },
      20,
    );
    expect(new URL(url).searchParams.get("cursor")).toBe(cursor);
  });

  it("serves a repeat search from the edge cache, without calling the API", async () => {
    const stored = new Map<string, Response>();
    const cache = {
      match: async (request: Request) => stored.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => void stored.set(request.url, response),
    };
    const upstream = vi.fn(async () => apiPage([], null));

    await runSearch({ queries: ["data engineer"] }, 0, { upstream, cache });
    await runSearch({ queries: ["data engineer"] }, 0, { upstream, cache });

    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("shares the edge cache with the public proxy, whatever the parameter order", async () => {
    const stored = new Map<string, Response>();
    const cache = {
      match: async (request: Request) => stored.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => void stored.set(request.url, response),
    };
    const searchUpstream = vi.fn(async () => apiPage([], null));
    const proxyUpstream = vi.fn(async () => apiPage([], null));

    await runSearch({ queries: ["data engineer"], locations: ["remote"] }, 0, {
      upstream: searchUpstream,
      cache,
    });
    const response = await handlePublic(
      new Request(
        "https://tallo.nandan.fyi/v1/search?location=remote&limit=20&title=data+engineer",
      ),
      { upstream: proxyUpstream, cache },
    );

    expect(response.status).toBe(200);
    expect(proxyUpstream).not.toHaveBeenCalled();
  });

  it("throws on a failed answer, so the page shows its message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 })),
    );
    await expect(runSearch({ queries: ["data engineer"] }, 0)).rejects.toThrow(
      "API 503 for /v1/search",
    );
  });
});
