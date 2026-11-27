import { describe, expect, it } from "vitest";
import { createHostBreaker, createHostLimiter, createHttp, HttpError } from "../src/index.ts";

/** A breaker on a clock the test moves. */
function clocked(
  options: { threshold?: number; cooldownMs?: number; maxCooldownMs?: number } = {},
) {
  let now = 1_000_000;
  const breaker = createHostBreaker({ threshold: 3, cooldownMs: 1000, ...options, now: () => now });
  const advance = (ms: number): void => {
    now += ms;
  };
  return { breaker, advance };
}

const refuse = (breaker: ReturnType<typeof createHostBreaker>, times: number, status = 403) => {
  for (let i = 0; i < times; i++) {
    breaker.admit("h", "https://h/x");
    breaker.report("h", status);
  }
};

describe("createHostBreaker", () => {
  it("lets requests through until the threshold of refusals in a row", () => {
    const { breaker } = clocked();
    refuse(breaker, 2);
    expect(() => breaker.admit("h", "https://h/x")).not.toThrow();
    breaker.report("h", 403);
    expect(() => breaker.admit("h", "https://h/x")).toThrow(HttpError);
  });

  it("counts 403 and 429 together and ignores other statuses", () => {
    const { breaker } = clocked();
    breaker.report("h", 403);
    breaker.report("h", 500);
    breaker.report("h", 404);
    breaker.report("h", 429);
    breaker.report("h", 403);
    expect(() => breaker.admit("h", "https://h/x")).toThrow(/refused 3 requests/);
  });

  it("a success resets the count", () => {
    const { breaker } = clocked();
    refuse(breaker, 2);
    breaker.report("h", 200);
    refuse(breaker, 2);
    expect(() => breaker.admit("h", "https://h/x")).not.toThrow();
  });

  it("fails fast with a blocked error that says how long to wait", () => {
    const { breaker, advance } = clocked();
    refuse(breaker, 3);
    advance(400);
    try {
      breaker.admit("h", "https://h/x");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).kind).toBe("blocked");
      expect((error as HttpError).retryAfterMs).toBe(600);
      expect((error as HttpError).message).toContain("1 s");
    }
  });

  it("lets exactly one probe through when the cooldown ends, and closes on its success", () => {
    const { breaker, advance } = clocked();
    refuse(breaker, 3);
    advance(1000);
    breaker.admit("h", "https://h/x");
    expect(() => breaker.admit("h", "https://h/x")).toThrow(/probed/);
    breaker.report("h", 200);
    expect(() => breaker.admit("h", "https://h/x")).not.toThrow();
    expect(() => breaker.admit("h", "https://h/x")).not.toThrow();
  });

  it("reopens for twice as long when the probe is refused, up to the maximum", () => {
    const { breaker, advance } = clocked({ maxCooldownMs: 3000 });
    refuse(breaker, 3);
    const waits: number[] = [];
    for (let round = 0; round < 4; round++) {
      advance(10_000);
      breaker.admit("h", "https://h/x");
      breaker.report("h", 403);
      try {
        breaker.admit("h", "https://h/x");
      } catch (error) {
        waits.push((error as HttpError).retryAfterMs ?? 0);
      }
    }
    expect(waits).toEqual([2000, 3000, 3000, 3000]);
  });

  it("a probe with no answer is retried instead of stuck", () => {
    const { breaker, advance } = clocked();
    refuse(breaker, 3);
    advance(1000);
    breaker.admit("h", "https://h/x");
    breaker.report("h", 0);
    expect(() => breaker.admit("h", "https://h/x")).not.toThrow();
  });

  it("keeps hosts apart", () => {
    const { breaker } = clocked();
    refuse(breaker, 3);
    expect(() => breaker.admit("other", "https://other/x")).not.toThrow();
  });
});

describe("createHttp with a breaker", () => {
  const blockedSite = () => {
    const calls = { n: 0 };
    const fetchImpl: typeof fetch = async () => {
      calls.n++;
      return new Response("blocked", { status: 403 });
    };
    return { calls, fetchImpl };
  };

  it("stops sending requests to a host that keeps answering 403", async () => {
    const { calls, fetchImpl } = blockedSite();
    const http = createHttp({
      fetch: fetchImpl,
      allowedHosts: ["api.example.com"],
      retryDelay: () => 0,
      breaker: createHostBreaker({ threshold: 3 }),
    });
    const outcomes: string[] = [];
    for (let i = 0; i < 8; i++) {
      try {
        await http.getJson("https://api.example.com/x");
      } catch (error) {
        outcomes.push(`${(error as HttpError).kind}:${(error as HttpError).status}`);
      }
    }
    expect(calls.n).toBe(3);
    expect(outcomes).toEqual([
      "http:403",
      "http:403",
      "http:403",
      "blocked:0",
      "blocked:0",
      "blocked:0",
      "blocked:0",
      "blocked:0",
    ]);
  });

  it("clients that share a limiter share the breaker", async () => {
    const { calls, fetchImpl } = blockedSite();
    const limiter = createHostLimiter({});
    const client = () =>
      createHttp({
        fetch: fetchImpl,
        allowedHosts: ["a.example.com"],
        retryDelay: () => 0,
        limiter,
      });
    const [one, two] = [client(), client()];
    for (let i = 0; i < 8; i++) await one.getJson("https://a.example.com/x").catch(() => {});
    const before = calls.n;
    await expect(two.getJson("https://a.example.com/x")).rejects.toMatchObject({ kind: "blocked" });
    expect(calls.n).toBe(before);
  });

  it("does not trip on an ordinary 404 or on a few refusals between successes", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n++;
      return n % 3 === 0
        ? new Response("{}", { status: 200 })
        : new Response("no", { status: 403 });
    };
    const http = createHttp({
      fetch: fetchImpl,
      allowedHosts: ["api.example.com"],
      retryDelay: () => 0,
      breaker: createHostBreaker({ threshold: 3 }),
    });
    for (let i = 0; i < 12; i++) await http.getJson("https://api.example.com/x").catch(() => {});
    expect(n).toBe(12);
  });
});
