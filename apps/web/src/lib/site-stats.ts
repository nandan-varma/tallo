import { PUBLIC_ORIGIN, SITE_STATS_TTL_SECONDS, type SiteStats } from "@tallo/contracts";
import type { EdgeCache } from "@/lib/public";

/**
 * The snapshot behind /status, through the edge cache. A snapshot reads a few hundred thousand rows, so it is computed
 * at most once per 12 hours per location: a fresh entry is served as is, an entry between 12 hours and a week old is
 * served when the API cannot answer, and a page view never reaches the database otherwise. Never computed on a timer.
 */
const KEY = `${PUBLIC_ORIGIN}/__site-stats`;
const KEEP_SECONDS = 7 * 86400;

export interface SiteStatsDeps {
  upstream: (pathAndQuery: string) => Promise<Response>;
  cache?: EdgeCache;
  now?: () => number;
}

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
  const cached = await read(await cache?.match(request).catch(() => undefined));
  if (cached && now() - cached.asOf < SITE_STATS_TTL_SECONDS) return cached;
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
