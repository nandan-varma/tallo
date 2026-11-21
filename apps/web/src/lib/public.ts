import {
  POSTING_ID_SOURCE,
  PUBLIC_MAX_URL_CHARS,
  PUBLIC_ORIGIN,
  PUBLIC_PATHS,
  PUBLIC_RATE_PER_MINUTE,
  type PublicError,
  publicError,
} from "@tallo/contracts";

/**
 * The public proxy: GET-only, allowlisted, rate limited per address, and cached at the edge. The API behind it is
 * never reachable through these paths except as listed in `PUBLIC_PATHS`.
 */

/** The Cache API, as far as this module uses it (`caches.default` in production). */
export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** The Workers rate limiting binding, as far as this module uses it. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface PublicDeps {
  /** Calls the API with a path and query: the service binding in production. */
  upstream: (pathAndQuery: string) => Promise<Response>;
  cache?: EdgeCache;
  limiter?: Limiter;
}

/** Each allowlisted path as a pattern: `:id` is a posting id and nothing else, so no other path can match. */
const PATTERNS = PUBLIC_PATHS.map(
  (path) =>
    new RegExp(
      `^${path
        .split(/(:id)/)
        .map((part) =>
          part === ":id" ? POSTING_ID_SOURCE : part.replace(/[/.]/g, (c) => `\\${c}`),
        )
        .join("")}$`,
    ),
);

export const isPublicPath = (pathname: string): boolean =>
  PATTERNS.some((pattern) => pattern.test(pathname));

/** The URL the cache and the API see: the public origin, and the query parameters in sorted order. */
export function normalizedPathAndQuery(url: URL): string {
  const entries = [...url.searchParams].sort(([a, av], [b, bv]) =>
    a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1,
  );
  const query = new URLSearchParams(entries).toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

const cacheKeyOf = (pathAndQuery: string) => new Request(`${PUBLIC_ORIGIN}${pathAndQuery}`);

/** A JSON error the proxy answers itself. Never cached: a corrected request must not meet an old mistake. */
function reply(status: number, body: PublicError, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** Whether this address may make another request. Fails open when no limiter is bound (local development). */
export async function admit(request: Request, limiter: Limiter | undefined): Promise<boolean> {
  if (!limiter) return true;
  const { success } = await limiter.limit({
    key: request.headers.get("cf-connecting-ip") ?? "unknown",
  });
  return success;
}

/**
 * The answer for a path and query: from the edge cache when it has it, else from the API. Only a 200 is stored; the
 * API's own Cache-Control decides how long.
 */
export async function answer(pathAndQuery: string, deps: PublicDeps): Promise<Response> {
  const key = cacheKeyOf(pathAndQuery);
  const cached = await deps.cache?.match(key);
  if (cached) return cached;
  const response = await deps.upstream(pathAndQuery);
  if (response.status === 200 && deps.cache) {
    try {
      await deps.cache.put(key, response.clone());
    } catch {
      // A failed store only costs the next request its cache hit.
    }
  }
  return response;
}

/** The public request handler behind `/v1/*`: allowlist, method, size, rate limit, then the cached answer. */
export async function handlePublic(request: Request, deps: PublicDeps): Promise<Response> {
  const url = new URL(request.url);
  if (!isPublicPath(url.pathname)) {
    return reply(
      404,
      publicError(
        "not_found",
        "This path is not part of the public API.",
        "The public API is GET /v1/search, GET /v1/jobs/:id and GET /v1/jobs/:id/description. Read /llms.txt.",
      ),
    );
  }
  if (request.method !== "GET") {
    return reply(
      405,
      publicError(
        "method_not_allowed",
        `${request.method} is not allowed here.`,
        "Use GET. The public API only reads.",
      ),
      { allow: "GET" },
    );
  }
  if (url.pathname.length + url.search.length > PUBLIC_MAX_URL_CHARS) {
    return reply(
      414,
      publicError(
        "uri_too_long",
        `The path and query are longer than ${PUBLIC_MAX_URL_CHARS} characters.`,
        "Use fewer or shorter title, company and location values.",
      ),
    );
  }
  if (!(await admit(request, deps.limiter))) {
    return reply(
      429,
      publicError(
        "rate_limited",
        `Too many requests from this address: about ${PUBLIC_RATE_PER_MINUTE} a minute.`,
        "Wait a minute, then retry. Keep your own copy of answers: search results change at most every few minutes.",
      ),
      { "retry-after": "60" },
    );
  }
  return answer(normalizedPathAndQuery(url), deps);
}
