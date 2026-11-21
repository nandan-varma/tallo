import { expect, it, vi } from "vitest";
import { createApi } from "../src/api.ts";

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
