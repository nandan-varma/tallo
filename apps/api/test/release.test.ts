import { LLMS_EXAMPLES, llmsText, publicError } from "@tallo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { smoke } from "../../../scripts/smoke.ts";

afterEach(() => vi.unstubAllGlobals());

function releaseFetch(options: { malformedSearch?: boolean; exposedApi?: boolean } = {}) {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input);
    paths.push(url.href);
    if (url.host === "api.test")
      return options.exposedApi
        ? Response.json(LLMS_EXAMPLES.search)
        : Response.json(publicError("not_found", "No such route", "Use the web host"), {
            status: 404,
          });
    if (url.pathname === "/llms.txt")
      return new Response(llmsText(), { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url.pathname === "/v1/openapi.json") return Response.json({ openapi: "3.1.0" });
    return Response.json(options.malformedSearch ? { results: [] } : LLMS_EXAMPLES.search);
  });
  return paths;
}

it("checks schema-valid search results and isolation of every public API route", async () => {
  const paths = releaseFetch();
  await smoke("https://web.test", "https://api.test");
  expect(paths.filter((path) => path.startsWith("https://api.test"))).toHaveLength(6);
});
it("fails release when an API host exposes public reads", async () => {
  releaseFetch({ exposedApi: true });
  await expect(smoke("https://web.test", "https://api.test")).rejects.toThrow("release check");
});
it("fails release on malformed successful search responses", async () => {
  releaseFetch({ malformedSearch: true });
  await expect(smoke("https://web.test", "https://api.test")).rejects.toThrow("release check");
});
