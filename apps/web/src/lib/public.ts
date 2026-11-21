import {
  cursorOffset,
  POSTING_ID_SOURCE,
  PUBLIC_COST_HEADER,
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

/** The offsets a search log line can name, as ranges: the exact offset is not needed to see how deep a walk goes. */
export type OffsetBucket = "0" | "1-24" | "25-99" | "100-299";

/** One line per public request. `null` means the figure was not known (not that it was zero). */
export interface PublicLogLine {
  event: "public_request";
  route: string;
  status: number;
  ms: number;
  cache: "hit" | "miss" | "none";
  offset: OffsetBucket | null;
  statements: number | null;
  rows_read: number | null;
  rows_written: number | null;
  rows_returned: number | null;
}

/** What the API reported for an answer (see `PUBLIC_COST_HEADER`). */
interface UpstreamCost {
  statements: number | null;
  rows_read: number | null;
  rows_written: number | null;
  rows_returned: number | null;
}

export interface PublicDeps {
  /** Calls the API with a path and query: the service binding in production. */
  upstream: (pathAndQuery: string) => Promise<Response>;
  cache?: EdgeCache;
  limiter?: Limiter;
  /** Receives one line per public request. Unset: nothing is logged. */
  log?: (line: PublicLogLine) => void;
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

/** The public reads are credential-free, GET-only, and cached at the edge: `*` is the honest origin policy. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
} as const;

/** A stored response may predate a header change, so every answer leaves through this. */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS)) {
    if (name !== "access-control-max-age") headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** A JSON error the proxy answers itself. Never cached: a corrected request must not meet an old mistake. */
function reply(status: number, body: PublicError, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...CORS, ...headers },
  });
}

/**
 * Whether this address may make another request. Fails open when no limiter is bound (local development), and fails
 * closed when a limiter is bound but the edge did not supply an address: callers without a trustworthy key must not
 * share one unlimited or cross-caller bucket. Only `cf-connecting-ip` is used; other forwarding headers are spoofable.
 */
export async function admit(request: Request, limiter: Limiter | undefined): Promise<boolean> {
  if (!limiter) return true;
  const address = request.headers.get("cf-connecting-ip")?.trim();
  if (!address) return false;
  const { success } = await limiter.limit({ key: address });
  return success;
}

/** Statuses the API may mark as stable: only with a public, timed Cache-Control (see `NEGATIVE_CACHE_CONTROL`). */
const STABLE_NEGATIVE = new Set([404, 410]);

/** Whether the edge may keep this answer: every 200, and a stable negative the API marked public with a max-age. */
function storable(response: Response): boolean {
  if (response.status === 200) return true;
  const control = response.headers.get("cache-control") ?? "";
  return STABLE_NEGATIVE.has(response.status) && control.startsWith("public, max-age=");
}

/** The API's cost header, read into its figures. A value that does not parse counts as no cost report. */
function parseCost(value: string | null): UpstreamCost | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const figure = (name: string) => (typeof parsed[name] === "number" ? parsed[name] : null);
    return {
      statements: figure("statements") as number | null,
      rows_read: figure("rows_read") as number | null,
      rows_written: figure("rows_written") as number | null,
      rows_returned: figure("rows_returned") as number | null,
    };
  } catch {
    return null;
  }
}

/** The same answer without the API's cost header: that header describes one origin call, and must not outlive it. */
function withoutCost(response: Response): { response: Response; cost: UpstreamCost | null } {
  const cost = parseCost(response.headers.get(PUBLIC_COST_HEADER));
  if (!response.headers.has(PUBLIC_COST_HEADER)) return { response, cost };
  const headers = new Headers(response.headers);
  headers.delete(PUBLIC_COST_HEADER);
  return {
    response: new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    cost,
  };
}

/** How one request was answered: the response, whether the edge had it, and what the origin reported (if it ran). */
interface Outcome {
  response: Response;
  cache: PublicLogLine["cache"];
  cost: UpstreamCost | null;
}

/** A hit costs the database nothing. */
const NO_DB_WORK: UpstreamCost = { statements: 0, rows_read: 0, rows_written: 0, rows_returned: 0 };

/** The answer for a path and query: from the edge cache when it has it, else from the API. */
async function outcomeOf(pathAndQuery: string, deps: PublicDeps): Promise<Outcome> {
  // Every caller shares one spelling of a question, so the public proxy and the search page share its cache entry.
  const canonical = normalizedPathAndQuery(new URL(pathAndQuery, PUBLIC_ORIGIN));
  const key = cacheKeyOf(canonical);
  const cached = await deps.cache?.match(key);
  if (cached) return { response: cached, cache: "hit", cost: NO_DB_WORK };
  const { response, cost } = withoutCost(await deps.upstream(canonical));
  if (deps.cache && storable(response)) {
    try {
      await deps.cache.put(key, response.clone());
    } catch {
      // A failed store only costs the next request its cache hit.
    }
  }
  return { response, cache: deps.cache ? "miss" : "none", cost };
}

/** The bucket a search cursor's offset falls in; null for a route that pages nothing. */
export function offsetBucket(offset: number): OffsetBucket {
  if (offset === 0) return "0";
  if (offset < 25) return "1-24";
  if (offset < 100) return "25-99";
  return "100-299";
}

/** The allowlisted route a path is, or `none` for anything else. */
function routeOf(pathname: string): string {
  const index = PATTERNS.findIndex((pattern) => pattern.test(pathname));
  return index === -1 ? "none" : (PUBLIC_PATHS[index] as string);
}

/** Writes the one line a public request leaves. A search cursor is read for its offset bucket; the cursor is not logged. */
function emit(deps: PublicDeps, pathAndQuery: string, started: number, outcome: Outcome) {
  if (!deps.log) return;
  const url = new URL(pathAndQuery, PUBLIC_ORIGIN);
  const route = routeOf(url.pathname);
  let offset: OffsetBucket | null = null;
  if (route === "/v1/search") {
    const cursor = url.searchParams.get("cursor");
    const decoded = cursor === null ? 0 : cursorOffset(cursor);
    offset = decoded === null ? null : offsetBucket(decoded);
  }
  deps.log({
    event: "public_request",
    route,
    status: outcome.response.status,
    ms: Date.now() - started,
    cache: outcome.cache,
    offset,
    statements: outcome.cost?.statements ?? null,
    rows_read: outcome.cost?.rows_read ?? null,
    rows_written: outcome.cost?.rows_written ?? null,
    rows_returned: outcome.cost?.rows_returned ?? null,
  });
}

/**
 * The answer for a path and query, as the search page and the proxy both get it: from the edge cache when it has it,
 * else from the API. Only a 200, or a stable negative the API marked public, is stored; the API's own Cache-Control
 * decides how long.
 */
export async function answer(pathAndQuery: string, deps: PublicDeps): Promise<Response> {
  const started = Date.now();
  const outcome = await outcomeOf(pathAndQuery, deps);
  emit(deps, pathAndQuery, started, outcome);
  return outcome.response;
}

/** The public request handler behind `/v1/*`: allowlist, method, size, rate limit, then the cached answer. */
export async function handlePublic(request: Request, deps: PublicDeps): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const outcome = await respond(request, url, deps);
  emit(deps, normalizedPathAndQuery(url), started, outcome);
  return outcome.response;
}

async function respond(request: Request, url: URL, deps: PublicDeps): Promise<Outcome> {
  const refused = (response: Response): Outcome => ({ response, cache: "none", cost: null });
  if (!isPublicPath(url.pathname)) {
    return refused(
      reply(
        404,
        publicError(
          "not_found",
          "This path is not part of the public API.",
          "The public API is GET /v1/search, /v1/jobs/:id, /v1/jobs/:id/description, /v1/companies, /v1/titles and /v1/openapi.json. Read /llms.txt.",
        ),
      ),
    );
  }
  if (request.method === "OPTIONS") {
    return refused(new Response(null, { status: 204, headers: CORS }));
  }
  if (request.method !== "GET") {
    return refused(
      reply(
        405,
        publicError(
          "method_not_allowed",
          `${request.method} is not allowed here.`,
          "Use GET. The public API only reads.",
        ),
        { allow: "GET, OPTIONS" },
      ),
    );
  }
  if (url.pathname.length + url.search.length > PUBLIC_MAX_URL_CHARS) {
    return refused(
      reply(
        414,
        publicError(
          "uri_too_long",
          `The path and query are longer than ${PUBLIC_MAX_URL_CHARS} characters.`,
          "Use fewer or shorter title, company and location values.",
        ),
      ),
    );
  }
  if (!(await admit(request, deps.limiter))) {
    return refused(
      reply(
        429,
        publicError(
          "rate_limited",
          `Too many requests from this address: about ${PUBLIC_RATE_PER_MINUTE} a minute.`,
          "Wait a minute, then retry. Keep your own copy of answers: search results change at most every few minutes.",
        ),
        { "retry-after": "60" },
      ),
    );
  }
  const answered = await outcomeOf(normalizedPathAndQuery(url), deps);
  return { ...answered, response: withCors(answered.response) };
}
