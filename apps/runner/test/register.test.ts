import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";
import { loadHot, loadSources } from "../src/sources.ts";

const SOURCES_DIR = fileURLToPath(new URL("../../../sources", import.meta.url));
const TYPO_DIR = fileURLToPath(new URL("./fixtures/hot-typo/", import.meta.url));

describe("hot list", () => {
  it("the reviewed hot.json names only boards that exist in sources/, and is about 50 to 100 boards", () => {
    const hot = loadHot(SOURCES_DIR, loadSources(SOURCES_DIR));
    expect(hot.length).toBeGreaterThanOrEqual(50);
    expect(hot.length).toBeLessThanOrEqual(100);
  });

  it("loadSources does not read hot.json as a platform", () => {
    expect(loadSources(SOURCES_DIR).every((s) => s.platform !== "hot")).toBe(true);
  });

  it("refuses a hot id that is not a configured source", () => {
    expect(() => loadHot(TYPO_DIR, loadSources(SOURCES_DIR))).toThrow(/greenhouse:stipe/);
  });
});

describe("registration", () => {
  it("posts the configs and the hot list, and returns the count the API registered", async () => {
    const seen: { sources: unknown[]; hot: string[] }[] = [];
    const fetchFake: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/v1/admin/sources") return new Response("", { status: 404 });
      const body = (
        input instanceof Request ? await input.json() : JSON.parse(String(init?.body))
      ) as { sources: unknown[]; hot: string[] };
      seen.push(body);
      return Response.json({ registered: body.sources.length });
    };
    const api = createApi("https://api.test", "t", fetchFake);
    const config = {
      id: "greenhouse:a",
      platform: "greenhouse",
      key: "a",
      company: "A",
      params: {},
    };
    expect(await api.registerSources([config], ["greenhouse:a"])).toEqual({ registered: 1 });
    expect(seen).toEqual([{ sources: [config], hot: ["greenhouse:a"] }]);
  });
});
