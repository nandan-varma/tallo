import { describe, expect, it } from "vitest";
import { createHostLimiter, createHttp, type HostLimiter } from "../src/index.ts";

const allowedHosts = ["api.example.com"];
const urls = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `https://api.example.com/${prefix}${i}`);

/** One fake fetch shared by every client in a test; tracks the peak in-flight count across all. */
function countingFetch() {
  const state = { inFlight: 0, peak: 0 };
  const fetchImpl = (async () => {
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.inFlight--;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, state };
}

/** Two "sources" issue 10 requests each to the same host at the same time. */
async function runTwoSources(
  limiterA: HostLimiter,
  limiterB: HostLimiter,
  fetchImpl: typeof fetch,
) {
  const httpA = createHttp({ fetch: fetchImpl, allowedHosts, limiter: limiterA });
  const httpB = createHttp({ fetch: fetchImpl, allowedHosts, limiter: limiterB });
  await Promise.all([
    ...urls("a", 10).map((u) => httpA.getJson(u)),
    ...urls("b", 10).map((u) => httpB.getJson(u)),
  ]);
}

describe("createHostLimiter", () => {
  it("never exceeds the host cap when clients share one limiter", async () => {
    const shared = createHostLimiter({ perHostConcurrency: 2 });
    const { fetchImpl, state } = countingFetch();
    await runTwoSources(shared, shared, fetchImpl);
    expect(state.peak).toBe(2);
  });

  it("gives clients with separate limiters independent caps", async () => {
    const { fetchImpl, state } = countingFetch();
    await runTwoSources(
      createHostLimiter({ perHostConcurrency: 2 }),
      createHostLimiter({ perHostConcurrency: 2 }),
      fetchImpl,
    );
    // Each limiter allows 2, so the two together can reach 4 on the same host.
    expect(state.peak).toBe(4);
  });

  it("keys queues by host, so different hosts do not share a cap", async () => {
    const limiter = createHostLimiter({ perHostConcurrency: 1 });
    const state = { inFlight: 0, peak: 0 };
    const fetchImpl = (async () => {
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.inFlight--;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const http = createHttp({
      fetch: fetchImpl,
      allowedHosts: ["api.example.com", "boards.example.com"],
      limiter,
    });
    await Promise.all([
      http.getJson("https://api.example.com/x"),
      http.getJson("https://boards.example.com/x"),
    ]);
    expect(state.peak).toBe(2);
  });
});
