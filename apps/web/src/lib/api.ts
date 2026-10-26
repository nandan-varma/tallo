import { env } from "cloudflare:workers";
import type { Facets, JobDetail, JobPage } from "@tallo/contracts";
import type { RunRecord, SourceRecord } from "@/lib/status";

const inFlight = new Map<string, Promise<unknown>>();
// Cloudflare exposes a default edge cache in addition to the standard CacheStorage API.
const edgeCache = caches as CacheStorage & { default: Cache };

/**
 * Calls the internal API through a Worker-local cache. The web worker runs auth
 * before a page or endpoint can call this, so cached API payloads never become
 * publicly reachable. Keeping the cache here avoids repeat D1 reads (and R2
 * reads for descriptions) across server renders and the hydrated detail route.
 */
async function call<T>(path: string, maxAgeSeconds: number): Promise<T | null> {
  const cacheKey = new Request(`https://tallo-cache.internal${path}`);
  const cached = await edgeCache.default.match(cacheKey);
  if (cached) return (await cached.json()) as T;

  const existing = inFlight.get(path) as Promise<T | null> | undefined;
  if (existing) return existing;

  const request = (async () => {
    const init = { headers: { authorization: `Bearer ${env.READ_TOKEN}` } };
    const response = env.API
      ? await env.API.fetch(new Request(`https://api.internal${path}`, init))
      : await fetch(`${env.API_URL}${path}`, init);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`API ${response.status} for ${path}`);

    const cacheResponse = new Response(response.clone().body, {
      headers: {
        "cache-control": `public, max-age=${maxAgeSeconds}`,
        "content-type": "application/json; charset=utf-8",
      },
    });
    await edgeCache.default.put(cacheKey, cacheResponse);
    return (await response.json()) as T;
  })();

  inFlight.set(path, request);
  try {
    return await request;
  } finally {
    inFlight.delete(path);
  }
}

/** Calls the internal API: the service binding in production, `API_URL` in local dev. */
function canonicalQuery(query: URLSearchParams) {
  const normalized = new URLSearchParams([...query].filter(([, value]) => value !== ""));
  normalized.sort();
  return normalized;
}

export const searchJobs = (query: URLSearchParams) =>
  call<JobPage>(`/v1/jobs?${canonicalQuery(query)}`, 30) as Promise<JobPage>;

/**
 * Facet counts are rebuilt hourly by the API cron, so a few minutes of edge caching is fine.
 * Resolves to null on 404 (no facets endpoint); callers must handle it.
 */
export const getFacets = () => call<Facets>("/v1/facets", 300);

/** Detail descriptions change only when the source job changes, so a longer TTL is safe. */
export const getJob = (id: number) => call<JobDetail>(`/v1/jobs/${id}`, 300);

/** Operational reads for the status page. Short TTL: collection state changes over hours, not seconds. */
export const listSources = () =>
  call<SourceRecord[]>("/v1/sources/status", 60).then((rows) => rows ?? []);

export const listAttentionRuns = (limit = 50) =>
  call<RunRecord[]>(`/v1/runs?attention=true&limit=${limit}`, 60).then((rows) => rows ?? []);

/**
 * Runs one AI search on the API (POST, never cached). Returns the upstream response untouched so the
 * proxy route can pass the status and body through. `signal` is the browser request's signal, so a
 * cancelled search also cancels the upstream call.
 */
export function askJobs(body: string, signal?: AbortSignal): Promise<Response> {
  const path = "/v1/ai/ask";
  const init: RequestInit = {
    method: "POST",
    headers: { authorization: `Bearer ${env.READ_TOKEN}`, "content-type": "application/json" },
    body,
    signal,
  };
  return env.API
    ? env.API.fetch(new Request(`https://api.internal${path}`, init))
    : fetch(`${env.API_URL}${path}`, init);
}
