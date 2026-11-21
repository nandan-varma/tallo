import { expect, it, vi } from "vitest";
import { createApi } from "../src/api.ts";

it("posts an explicit retirement request and returns the audit result", async () => {
  const seen: { path: string; body: unknown }[] = [];
  const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = input instanceof Request ? await input.json() : JSON.parse(String(init?.body));
    seen.push({ path: url.pathname, body });
    return Response.json({
      sources: ["greenhouse:old"],
      jobs: 3,
      rawKeys: ["raw/greenhouse:old/run-1.ndjson.gz"],
      orphanJdHashes: ["a".repeat(64)],
      dryRun: true,
    });
  });
  const result = await createApi("https://api.test", "t", fakeFetch).retireSources(
    ["greenhouse:old"],
    true,
  );
  expect(seen).toEqual([
    {
      path: "/v1/admin/sources/retire",
      body: { sources: ["greenhouse:old"], dryRun: true },
    },
  ]);
  expect(result).toEqual({
    sources: ["greenhouse:old"],
    jobs: 3,
    rawKeys: ["raw/greenhouse:old/run-1.ndjson.gz"],
    orphanJdHashes: ["a".repeat(64)],
    dryRun: true,
  });
});

it("waits out the API's D1 overload window before retrying ingest", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>();
  fetch.mockResolvedValueOnce(
    new Response('{"error":"Database busy; retry later"}', {
      status: 503,
      headers: { "Retry-After": "10", "Content-Type": "application/json" },
    }),
  );
  fetch.mockResolvedValueOnce(Response.json({ changed: ["7"] }));
  try {
    const result = createApi("https://api.test", "test", fetch).diff("run-1", []);
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(["7"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
