import { PUBLIC_ORIGIN, SITE_STATS_TTL_SECONDS, type SiteStats } from "@tallo/contracts";
import type { EdgeCache } from "@/lib/public";

/**
 * The snapshot behind /status, through the edge cache. The API stores it hourly, so a miss is a one-row read: an entry
 * is served for five minutes from when it was fetched, an older one (up to a week) when the API cannot answer.
 */
const KEY = `${PUBLIC_ORIGIN}/__site-stats`;
const KEEP_SECONDS = 7 * 86400;

export interface SiteStatsDeps {
  upstream: (pathAndQuery: string) => Promise<Response>;
  cache?: EdgeCache;
  now?: () => number;
}

const FETCHED_AT = "x-fetched-at";

const read = async (response: Response | undefined): Promise<SiteStats | null> => {
  if (!response?.ok) return null;
  try {
    return (await response.json()) as SiteStats;
  } catch {
    return null;
  }
};

export async function loadSiteStats({
  upstream,
  cache,
  now = () => Date.now() / 1000,
}: SiteStatsDeps): Promise<SiteStats | null> {
  const request = new Request(KEY);
  const hit = await cache?.match(request).catch(() => undefined);
  const cached = await read(hit?.clone());
  const fetchedAt = Number(hit?.headers.get(FETCHED_AT));
  if (cached && now() - fetchedAt < SITE_STATS_TTL_SECONDS) return cached;
  try {
    const fresh = await read(await upstream("/v1/site-stats"));
    if (fresh) {
      await cache
        ?.put(
          request,
          new Response(JSON.stringify(fresh), {
            headers: {
              "content-type": "application/json",
              "cache-control": `public, max-age=${KEEP_SECONDS}`,
              [FETCHED_AT]: String(Math.floor(now())),
            },
          }),
        )
        .catch(() => undefined);
      return fresh;
    }
  } catch {
    // The API is down: fall through to the stale snapshot, if any.
  }
  return cached;
}
