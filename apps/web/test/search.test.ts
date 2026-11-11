import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: { READ_TOKEN: "read-token", API_URL: "http://api.test", API: undefined },
}));

import { runSearch } from "@/lib/api";
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
  it("is null without a title to search for", () => {
    expect(specFrom({ title: " , ", company: "Stripe", location: "" })).toBeNull();
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

  it("posts the spec with the page offset and size, using the read token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ hits: [], nextOffset: null }));
    vi.stubGlobal("fetch", fetchMock);

    const page = await runSearch({ queries: ["data engineer"] }, 20);

    expect(page).toEqual({ hits: [], nextOffset: null });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/v1/jobs/search");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer read-token");
    expect(JSON.parse(String(init.body))).toEqual({
      queries: ["data engineer"],
      offset: 20,
      limit: 20,
    });
  });

  it("throws on a failed answer, so the page shows its message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 })),
    );
    await expect(runSearch({ queries: ["data engineer"] }, 0)).rejects.toThrow("API 503");
  });
});
