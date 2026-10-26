import { env } from "cloudflare:workers";
import type { JobDetail, ProfileRecord } from "@tallo/contracts";
import type { RunRecord, SourceRecord } from "@/lib/status";

/**
 * One request to the internal API with the read token: the service binding in production, `API_URL` in
 * local dev. The proxy routes use it directly; reads that may be cached go through `call`.
 */
export function upstream(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.READ_TOKEN}`);
  const request = { ...init, headers };
  return env.API
    ? env.API.fetch(new Request(`https://api.internal${path}`, request))
    : fetch(`${env.API_URL}${path}`, request);
}

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
    const response = await upstream(path);
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

/** Detail descriptions change only when the source job changes, so a longer TTL is safe. */
export const getJob = (id: number) => call<JobDetail>(`/v1/jobs/${id}`, 300);

/** Operational reads for the status page. Short TTL: collection state changes over hours, not seconds. */
export const listSources = () =>
  call<SourceRecord[]>("/v1/sources/status", 60).then((rows) => rows ?? []);

export const listAttentionRuns = (limit = 50) =>
  call<RunRecord[]>(`/v1/runs?attention=true&limit=${limit}`, 60).then((rows) => rows ?? []);

/** The saved profile. Personal data: never cached. */
export async function getProfile(): Promise<ProfileRecord | null> {
  const response = await upstream("/v1/profile");
  if (!response.ok) throw new Error(`API ${response.status} for /v1/profile`);
  return (await response.json()) as ProfileRecord | null;
}
