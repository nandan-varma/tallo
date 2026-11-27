import type { Http, HttpInit, HttpResponse, Json } from "@tallo/contracts";
import ky, { HTTPError, isNetworkError, isTimeoutError } from "ky";
import PQueue from "p-queue";

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly retryAfterMs: number | undefined;
  /** `redirect`: a redirect pointed off the host allowlist (the board moved or was retired). */
  readonly kind: "http" | "schema" | "network" | "blocked" | "redirect";
  constructor(
    kind: HttpError["kind"],
    message: string,
    url: string,
    status = 0,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HttpError";
    this.kind = kind;
    this.url = url;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The key a host is limited under. Workday and Oracle Cloud limit per pod, not per tenant, so every
 * `<tenant>.wdN.myworkdayjobs.com` shares `wdN.myworkdayjobs.com` and every `<tenant>.fa[.<pod>].oraclecloud.com`
 * shares `fa[.<pod>].oraclecloud.com`. Any other host is its own key.
 */
export function podKey(host: string): string {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  const m =
    /^[^.]+\.(wd\d+\.myworkdayjobs\.com)$/.exec(h) ??
    /^[^.]+\.(fa\.(?:[a-z0-9-]+\.)?oraclecloud\.com)$/.exec(h);
  return m ? m[1]! : h;
}

/** A circuit breaker for one host key, shared by every client that shares a limiter. */
export interface HostBreaker {
  /**
   * Throws a `blocked` HttpError (with `retryAfterMs`) while the host is cooling down. When the cooldown ends it lets
   * exactly one probe request through; every other request keeps failing until that probe is reported.
   */
  admit(host: string, url: string): void;
  /** The final HTTP status of a request (after its retries), or 0 when no answer came back. */
  report(host: string, status: number): void;
}

interface HostBreakerOptions {
  /** Consecutive 403 or 429 answers that open the breaker. Default 8. */
  threshold?: number;
  /** First cooldown; it doubles with each further trip. Default 5 minutes (a typical edge rate-limit window). */
  cooldownMs?: number;
  /** Upper bound for the doubling cooldown. Default 60 minutes. */
  maxCooldownMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

interface BreakerState {
  refusals: number;
  trips: number;
  openUntil: number;
  probing: boolean;
}

/**
 * Stops hammering a host that refuses us. An edge firewall (Starbucks' CloudFront) answers 403 to every request once an
 * IP passes its rate rule, and keeps counting the requests made while blocked; the collector's retries and its next
 * postings would extend the block for as long as they kept going. After `threshold` 403 or 429 answers in a row with
 * no success between, the host fails fast for a cooldown (5 minutes, doubling to an hour while probes keep being
 * refused), then one probe decides: an answer that is not a refusal closes the breaker, another refusal reopens it.
 * Any answer that is not a 403 or 429 (a 404, a 5xx) is neither: it does not count, and it does not reset the count.
 */
export function createHostBreaker(options: HostBreakerOptions = {}): HostBreaker {
  const threshold = options.threshold ?? 8;
  const baseMs = options.cooldownMs ?? 5 * 60_000;
  const maxMs = options.maxCooldownMs ?? 60 * 60_000;
  const now = options.now ?? Date.now;
  const states = new Map<string, BreakerState>();
  const stateOf = (host: string): BreakerState => {
    let state = states.get(host);
    if (!state) {
      state = { refusals: 0, trips: 0, openUntil: 0, probing: false };
      states.set(host, state);
    }
    return state;
  };
  const trip = (state: BreakerState): void => {
    state.openUntil = now() + Math.min(maxMs, baseMs * 2 ** state.trips);
    state.trips++;
    state.probing = false;
  };
  return {
    admit(host, url) {
      const state = states.get(host);
      if (!state || state.openUntil === 0) return;
      const wait = state.openUntil - now();
      if (wait > 0) {
        throw new HttpError(
          "blocked",
          `${host} refused ${threshold} requests in a row (403 or 429); not asking again for ${Math.ceil(wait / 1000)} s`,
          url,
          0,
          wait,
        );
      }
      if (state.probing)
        throw new HttpError("blocked", `${host} is being probed after a cooldown`, url, 0, 5_000);
      state.probing = true;
    },
    report(host, status) {
      const state = stateOf(host);
      const refused = status === 403 || status === 429;
      if (state.probing) {
        if (refused) trip(state);
        else if (status === 0) state.probing = false;
        else {
          state.refusals = 0;
          state.trips = 0;
          state.openUntil = 0;
          state.probing = false;
        }
        return;
      }
      if (refused) {
        state.refusals++;
        if (state.refusals >= threshold) {
          state.refusals = 0;
          trip(state);
        }
      } else if (status >= 200 && status < 300) {
        state.refusals = 0;
      }
    },
  };
}

/** One breaker per limiter, so every client that shares a limiter shares what it learned about a host. */
const breakers = new WeakMap<HostLimiter, HostBreaker>();
function breakerFor(limiter: HostLimiter): HostBreaker {
  let breaker = breakers.get(limiter);
  if (!breaker) {
    breaker = createHostBreaker();
    breakers.set(limiter, breaker);
  }
  return breaker;
}

interface HostLimiterOptions {
  /** Maps a host to its limiting key (see `podKey`). Default: the host itself. */
  hostKey?: (host: string) => string;
  /** Concurrent in-flight requests per host: one number, or a function of the host. */
  perHostConcurrency?: number | ((host: string) => number);
  /** Minimum gap between request starts per host. */
  minHostIntervalMs?: number | ((host: string) => number);
}

/** Per-host queues. Share one instance across clients to bound a host process-wide. */
export interface HostLimiter {
  run<T>(host: string, task: () => Promise<T>): Promise<T>;
  /** Change the limits at runtime. Queued and future requests follow them; requests in flight finish. */
  setLimits(limits: { perHostConcurrency?: number; minHostIntervalMs?: number }): void;
  /**
   * A minimum start gap for one host, on top of the shared one: that host waits the larger of the two.
   * `undefined` or 0 removes it. Applies to the next request start.
   */
  setHostInterval?(host: string, ms: number | undefined): void;
}

export function createHostLimiter(options: HostLimiterOptions = {}): HostLimiter {
  let perHost: number | ((host: string) => number) = options.perHostConcurrency ?? 4;
  let interval: number | ((host: string) => number) = options.minHostIntervalMs ?? 0;
  const concurrencyOf = (host: string) => (typeof perHost === "function" ? perHost(host) : perHost);
  const hostIntervals = new Map<string, number>();
  const hosts = new Map<string, { queue: PQueue; nextStart: number }>();
  const keyOf = options.hostKey ?? ((host: string) => host);
  return {
    run<T>(rawHost: string, task: () => Promise<T>): Promise<T> {
      const host = keyOf(rawHost);
      let h = hosts.get(host);
      if (!h) {
        h = { queue: new PQueue({ concurrency: concurrencyOf(host) }), nextStart: 0 };
        hosts.set(host, h);
      }
      const state = h;
      // The start gap is reserved when a request gets its slot, so a change applies to the next start.
      return state.queue.add(async () => {
        const gap = Math.max(
          typeof interval === "function" ? interval(host) : interval,
          hostIntervals.get(host) ?? 0,
        );
        if (gap > 0) {
          const now = Date.now();
          const start = Math.max(now, state.nextStart);
          state.nextStart = start + gap;
          if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
        }
        return task();
      });
    },
    setLimits(limits) {
      if (limits.perHostConcurrency !== undefined) {
        perHost = limits.perHostConcurrency;
        for (const h of hosts.values()) h.queue.concurrency = limits.perHostConcurrency;
      }
      if (limits.minHostIntervalMs !== undefined) interval = limits.minHostIntervalMs;
    },
    setHostInterval(rawHost, ms) {
      const host = keyOf(rawHost);
      if (ms && ms > 0) hostIntervals.set(host, ms);
      else hostIntervals.delete(host);
    },
  };
}

interface HttpOptions {
  fetch?: typeof fetch;
  userAgent?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Shared per-host limiter. Pass one instance to every client that should share host limits.
   * When set, it wins: perHostConcurrency and minHostIntervalMs are ignored.
   * Default: a private limiter built from perHostConcurrency / minHostIntervalMs.
   */
  limiter?: HostLimiter;
  /**
   * Fails requests fast to a host that keeps refusing us (see `createHostBreaker`). Default: one breaker per
   * limiter, so clients that share a limiter share it. Pass one to share it across limiters.
   */
  breaker?: HostBreaker;
  /** Only used when no `limiter` is passed. */
  perHostConcurrency?: number;
  /** Only used when no `limiter` is passed. Gates new requests; retries (ky) run inside the slot without this gap. */
  minHostIntervalMs?: number;
  maxResponseBytes?: number;
  /**
   * Time allowed for reading the body, after the headers arrived. ky's `timeoutMs` covers headers only, so
   * a host that sends headers and then trickles the body would otherwise hold the request open. Default: timeoutMs.
   */
  bodyTimeoutMs?: number;
  /** Hostnames (or "*.suffix" patterns) requests may reach. Empty blocks everything. */
  allowedHosts: string[];
  signal?: AbortSignal;
  /** Override backoff (tests). Receives the 1-based retry attempt. */
  retryDelay?: (attempt: number) => number;
  onRequest?: () => void;
  /**
   * Time accounting, for measuring where a request's wall time goes. `limiter`: waited in the host limiter for a
   * slot or a start gap. `retry`: slept on Retry-After or backoff after a failed HTTP response (a retry after a
   * network error is not counted). `bytes`: body characters received.
   */
  onWait?: (kind: "limiter" | "retry", ms: number) => void;
  onBytes?: (n: number) => void;
}

/**
 * Backoff before retry `attempt` (1-based): exponential from 1s, capped at 30s, with equal jitter so
 * a retry never lands sooner than half its slot. Full jitter could retry almost at once after a 429.
 */
export function backoffMs(attempt: number, random = Math.random): number {
  const slot = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  return slot / 2 + random() * (slot / 2);
}

export function hostAllowed(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    return p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length >= p.length : host === p;
  });
}

/** Special-use IPv4 ranges that are not the public internet. */
function privateV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

export function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal"))
    return true;
  // A literal IPv6 host (a URL hostname keeps the brackets) is refused outright: that covers ::1, ULA fc00::/7,
  // link-local fe80::/10 and IPv4-mapped ::ffff:a.b.c.d alike.
  if (hostname.startsWith("[")) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname);
  return m ? privateV4(Number(m[1]), Number(m[2]), Number(m[3])) : false;
}

/**
 * Reads the body up to `max` bytes, within `timeoutMs`. On either limit the body stream is cancelled, which
 * releases the connection, so a stalled or oversized body cannot hold memory or a socket.
 */
async function readCapped(
  response: Response,
  max: number,
  url: string,
  timeoutMs: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max)
    throw new HttpError("blocked", `Response exceeds ${max} bytes`, url, response.status);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject before cancelling: cancelling settles the pending read as done, which must not win the race.
      reject(
        new HttpError(
          "network",
          `Response body not read within ${timeoutMs} ms`,
          url,
          response.status,
        ),
      );
      reader.cancel().catch(() => {});
    }, timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new HttpError("blocked", `Response exceeds ${max} bytes`, url, response.status);
      }
      chunks.push(value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return new TextDecoder().decode(
    await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer(),
  );
}

const etagOf = (response: Response) => {
  const etag = response.headers.get("etag");
  return etag ? { etag } : {};
};

export function createHttp(options: HttpOptions): Http {
  const maxBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? options.timeoutMs ?? 30_000;
  const limiter =
    options.limiter ??
    createHostLimiter({
      ...(options.perHostConcurrency !== undefined
        ? { perHostConcurrency: options.perHostConcurrency }
        : {}),
      ...(options.minHostIntervalMs !== undefined
        ? { minHostIntervalMs: options.minHostIntervalMs }
        : {}),
    });
  const breaker = options.breaker ?? breakerFor(limiter);
  const client = ky.create({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeout: options.timeoutMs ?? 30_000,
    redirect: "manual",
    headers: {
      "user-agent": options.userAgent ?? "TalloBot/0.1 (+https://tallo.nandan.fyi)",
      accept: "application/json, text/plain;q=0.9, */*;q=0.5",
    },
    // Retries run inside the single limiter.run task: a backing-off request keeps its per-host
    // slot (polite under 429s), but a retry does not wait for minHostIntervalMs.
    retry: {
      limit: options.maxRetries ?? 3,
      methods: ["get", "post"],
      statusCodes: [408, 429, 500, 502, 503, 504],
      // ky truncates a server's Retry-After to this cap, then retries early; an early retry under
      // a 429 burns the retry budget (Workday). Wait up to two minutes when the server asks for it.
      maxRetryAfter: 120_000,
      // A timed-out request is a slow host, not a dead one: retry it like a 5xx.
      retryOnTimeout: true,
      delay: backoffMs,
      // Plain fetch failures (DNS, reset, offline) surface as TypeError; retry them too.
      shouldRetry: ({ error }) => (error instanceof TypeError ? true : undefined),
      ...(options.retryDelay ? { delay: options.retryDelay } : {}),
    },
  });

  function check(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError("blocked", "Invalid URL", raw);
    }
    if (url.protocol !== "https:") throw new HttpError("blocked", "Only https is allowed", raw);
    if (url.username || url.password) throw new HttpError("blocked", "Credentials in URL", raw);
    if (isPrivateHost(url.hostname) || !hostAllowed(url.hostname, options.allowedHosts)) {
      throw new HttpError("blocked", `Host not allowed: ${url.hostname}`, raw);
    }
    return url;
  }

  async function request(
    method: "GET" | "POST",
    raw: string,
    body: Json | undefined,
    init?: HttpInit,
  ): Promise<HttpResponse<string>> {
    let url = check(raw);
    let verb = method;
    let payload = body;
    for (let hops = 0; hops <= 5; hops++) {
      options.signal?.throwIfAborted();
      try {
        const queuedAt = Date.now();
        // Set when a failed response arrives; the next retry hook measures the sleep since then.
        let failedAt = 0;
        const key = podKey(url.hostname);
        const response = await limiter.run(url.hostname, async () => {
          // Checked at the start of the slot, so requests that queued before the breaker opened fail fast too,
          // and a refused request does not count as a request made.
          breaker.admit(key, url.href);
          options.onWait?.("limiter", Date.now() - queuedAt);
          options.onRequest?.();
          try {
            const answer = await client(url, {
              hooks: {
                afterResponse: [
                  ({ response: r }: { response: Response }) => {
                    if (!r.ok) failedAt = Date.now();
                  },
                ],
                beforeRetry: [
                  () => {
                    if (failedAt) options.onWait?.("retry", Date.now() - failedAt);
                    failedAt = 0;
                  },
                ],
              },
              method: verb,
              ...(payload === undefined ? {} : { json: payload }),
              ...(init?.headers ? { headers: init.headers } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
              throwHttpErrors: (status) =>
                !(status >= 300 && status < 400) && !init?.okStatuses?.includes(status),
            });
            breaker.report(key, answer.status);
            return answer;
          } catch (error) {
            breaker.report(key, error instanceof HTTPError ? error.response.status : 0);
            throw error;
          }
        });
        // A 304 is the answer to a conditional request, not a redirect; only when the caller allows it.
        if (response.status === 304 && init?.okStatuses?.includes(304)) {
          await response.body?.cancel();
          return { status: 304, url: url.href, data: "", ...etagOf(response) };
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location)
            throw new HttpError("http", "Redirect without location", url.href, response.status);
          const target = new URL(location, url);
          if (!hostAllowed(target.hostname, options.allowedHosts)) {
            throw new HttpError(
              "redirect",
              `Redirected to a host outside the allowlist: ${target.hostname}`,
              url.href,
              response.status,
            );
          }
          url = check(target.href);
          verb = "GET";
          payload = undefined;
          continue;
        }
        if (response.ok || init?.okStatuses?.includes(response.status)) {
          const data = await readCapped(response, maxBytes, url.href, bodyTimeoutMs);
          options.onBytes?.(data.length);
          return { status: response.status, url: url.href, data, ...etagOf(response) };
        }
        await response.body?.cancel();
        throw new HttpError(
          "http",
          `HTTP ${response.status}`,
          url.href,
          response.status,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof HTTPError)
          throw new HttpError(
            "http",
            error.message,
            url.href,
            error.response.status,
            parseRetryAfter(error.response.headers.get("retry-after")),
          );
        throw new HttpError(
          "network",
          error instanceof Error ? error.message : String(error),
          url.href,
        );
      }
    }
    throw new HttpError("blocked", "Too many redirects", raw);
  }

  function parse(res: HttpResponse<string>): HttpResponse<Json> {
    if (res.data === "") return { ...res, data: null };
    try {
      return { ...res, data: JSON.parse(res.data) as Json };
    } catch {
      throw new HttpError("schema", "Invalid JSON", res.url, res.status);
    }
  }

  return {
    getJson: async (url, init) => parse(await request("GET", url, undefined, init)),
    postJson: async (url, body, init) => parse(await request("POST", url, body, init)),
    getText: (url, init) => request("GET", url, undefined, init),
  };
}

/** HTTP Retry-After accepts either seconds or an HTTP date. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** One retry decision shared by board orchestration and persisted collection issues. */
export function failureOf(error: unknown): {
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
} {
  const status = error instanceof HttpError ? error.status : isHTTPErrorStatus(error);
  const headers = (error as { response?: { headers?: Headers } } | null)?.response?.headers;
  const retryAfterMs =
    error instanceof HttpError
      ? error.retryAfterMs
      : parseRetryAfter(headers?.get?.("retry-after"));
  const network =
    error instanceof HttpError
      ? error.kind === "network"
      : isNetworkError(error) ||
        isTimeoutError(error) ||
        (error instanceof TypeError && error.message === "fetch failed");
  return {
    retryable:
      network ||
      status === 408 ||
      status === 409 ||
      status === 429 ||
      (status !== undefined && status >= 500),
    ...(status ? { status } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function isHTTPErrorStatus(error: unknown): number | undefined {
  // Also accepts error-shaped test adapters; production ky errors carry response.status.
  const response = (error as { response?: { status?: unknown } } | null)?.response;
  return typeof response?.status === "number" ? response.status : undefined;
}
