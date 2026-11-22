import type { Http, HttpInit, HttpResponse, Json } from "@tallo/contracts";
import ky, { HTTPError } from "ky";
import PQueue from "p-queue";

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  /** `redirect`: a redirect pointed off the host allowlist (the board moved or was retired). */
  readonly kind: "http" | "schema" | "network" | "blocked" | "redirect";
  constructor(kind: HttpError["kind"], message: string, url: string, status = 0) {
    super(message);
    this.name = "HttpError";
    this.kind = kind;
    this.url = url;
    this.status = status;
  }
}

interface HostLimiterOptions {
  /** Concurrent in-flight requests per host: one number, or a function of the host. */
  perHostConcurrency?: number | ((host: string) => number);
  /** Minimum gap between request starts per host. */
  minHostIntervalMs?: number;
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
  let interval = options.minHostIntervalMs ?? 0;
  const concurrencyOf = (host: string) => (typeof perHost === "function" ? perHost(host) : perHost);
  const hostIntervals = new Map<string, number>();
  const hosts = new Map<string, { queue: PQueue; nextStart: number }>();
  return {
    run<T>(host: string, task: () => Promise<T>): Promise<T> {
      let h = hosts.get(host);
      if (!h) {
        h = { queue: new PQueue({ concurrency: concurrencyOf(host) }), nextStart: 0 };
        hosts.set(host, h);
      }
      const state = h;
      // The start gap is reserved when a request gets its slot, so a change applies to the next start.
      return state.queue.add(async () => {
        const gap = Math.max(interval, hostIntervals.get(host) ?? 0);
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
    setHostInterval(host, ms) {
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

function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal"))
    return true;
  if (hostname.startsWith("[")) return true; // literal IPv6
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
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
        const response = await limiter.run(url.hostname, async () => {
          options.onRequest?.();
          return client(url, {
            method: verb,
            ...(payload === undefined ? {} : { json: payload }),
            ...(init?.headers ? { headers: init.headers } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            throwHttpErrors: (status) =>
              !(status >= 300 && status < 400) && !init?.okStatuses?.includes(status),
          });
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
          return {
            status: response.status,
            url: url.href,
            data: await readCapped(response, maxBytes, url.href, bodyTimeoutMs),
            ...etagOf(response),
          };
        }
        await response.body?.cancel();
        throw new HttpError("http", `HTTP ${response.status}`, url.href, response.status);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof HTTPError)
          throw new HttpError("http", error.message, url.href, error.response.status);
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
