import type { Http, HttpInit, HttpResponse, Json } from "@tallo/contracts";
import ky, { HTTPError } from "ky";
import PQueue from "p-queue";

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly kind: "http" | "schema" | "network" | "blocked";
  constructor(kind: HttpError["kind"], message: string, url: string, status = 0) {
    super(message);
    this.name = "HttpError";
    this.kind = kind;
    this.url = url;
    this.status = status;
  }
}

export interface HttpOptions {
  fetch?: typeof fetch;
  userAgent?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Concurrent in-flight requests per host. */
  perHostConcurrency?: number;
  /** Minimum gap between request starts per host. */
  minHostIntervalMs?: number;
  maxResponseBytes?: number;
  /** Hostnames (or "*.suffix" patterns) requests may reach. Empty blocks everything. */
  allowedHosts: string[];
  signal?: AbortSignal;
  /** Override backoff (tests). Receives the 1-based retry attempt. */
  retryDelay?: (attempt: number) => number;
  onRequest?: () => void;
}

export function hostAllowed(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    return p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length >= p.length : host === p;
  });
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (hostname.startsWith("[")) return true; // literal IPv6
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function readCapped(response: Response, max: number, url: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new HttpError("blocked", `Response exceeds ${max} bytes`, url, response.status);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new HttpError("blocked", `Response exceeds ${max} bytes`, url, response.status);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
}

export function createHttp(options: HttpOptions): Http {
  const maxBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
  const queues = new Map<string, PQueue>();
  const client = ky.create({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeout: options.timeoutMs ?? 30_000,
    redirect: "manual",
    headers: {
      "user-agent": options.userAgent ?? "TalloBot/0.1 (+https://tallo.nandan.fyi)",
      accept: "application/json, text/plain;q=0.9, */*;q=0.5",
    },
    retry: {
      limit: options.maxRetries ?? 3,
      methods: ["get", "post"],
      statusCodes: [408, 429, 500, 502, 503, 504],
      maxRetryAfter: 30_000,
      jitter: true,
      // Plain fetch failures (DNS, reset, offline) surface as TypeError; retry them too.
      shouldRetry: ({ error }) => (error instanceof TypeError ? true : undefined),
      ...(options.retryDelay ? { delay: options.retryDelay } : {}),
    },
  });

  const queue = (host: string): PQueue => {
    let q = queues.get(host);
    if (!q) {
      const interval = options.minHostIntervalMs ?? 0;
      q = new PQueue({
        concurrency: options.perHostConcurrency ?? 4,
        ...(interval > 0 ? { interval, intervalCap: 1 } : {}),
      });
      queues.set(host, q);
    }
    return q;
  };

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

  async function request(method: "GET" | "POST", raw: string, body: Json | undefined, init?: HttpInit): Promise<HttpResponse<string>> {
    let url = check(raw);
    let verb = method;
    let payload = body;
    for (let hops = 0; hops <= 5; hops++) {
      options.signal?.throwIfAborted();
      try {
        const response = await queue(url.hostname).add(
          async () => {
            options.onRequest?.();
            return client(url, {
              method: verb,
              ...(payload === undefined ? {} : { json: payload }),
              ...(init?.headers ? { headers: init.headers } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
              throwHttpErrors: (status) => !(status >= 300 && status < 400) && !init?.okStatuses?.includes(status),
            });
          },
          { throwOnTimeout: true },
        );
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw new HttpError("http", "Redirect without location", url.href, response.status);
          url = check(new URL(location, url).href);
          verb = "GET";
          payload = undefined;
          continue;
        }
        if (response.ok || init?.okStatuses?.includes(response.status)) {
          return { status: response.status, url: url.href, data: await readCapped(response, maxBytes, url.href) };
        }
        await response.body?.cancel();
        throw new HttpError("http", `HTTP ${response.status}`, url.href, response.status);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof HTTPError) throw new HttpError("http", error.message, url.href, error.response.status);
        throw new HttpError("network", error instanceof Error ? error.message : String(error), url.href);
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
