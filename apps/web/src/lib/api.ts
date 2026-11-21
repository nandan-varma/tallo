import { env } from "cloudflare:workers";
import {
  encodeCursor,
  type PublicSearchPage,
  type SearchPage,
  type SearchSpec,
} from "@tallo/contracts";
import { answer, type EdgeCache, type PublicDeps } from "@/lib/public";

/**
 * One request to the internal API: the service binding in production, `API_URL` in local dev. The API's public reads
 * need no token.
 */
export function upstream(path: string, init: RequestInit = {}): Promise<Response> {
  return env.API
    ? env.API.fetch(new Request(`https://api.internal${path}`, init))
    : fetch(`${env.API_URL}${path}`, init);
}

/** The Workers edge cache. Typed by hand: the DOM typings have no `caches.default`. */
const edgeCache = (): EdgeCache | undefined =>
  typeof caches === "undefined" ? undefined : (caches as unknown as { default: EdgeCache }).default;

/** The deps of the public proxy and of the search page, bound to this Worker's env. */
export function publicDeps(): PublicDeps {
  return { upstream, cache: edgeCache(), limiter: env.PUBLIC_LIMIT };
}

export const PAGE_SIZE = 20;

/**
 * One page of results for a search, through the same public answer everyone gets (edge cache included). The page's
 * cursor is built from the same title, company, location, country, date window and sort values the API checks it
 * against.
 */
export async function runSearch(
  spec: SearchSpec,
  offset: number,
  deps: PublicDeps = publicDeps(),
): Promise<SearchPage> {
  const query = {
    title: spec.queries,
    company: spec.companies ?? [],
    location: spec.locations ?? [],
    country: spec.countries ?? [],
    postedWithin: spec.postedWithin,
    sort: "relevance" as const,
  };
  const params = new URLSearchParams();
  for (const name of ["title", "company", "location", "country"] as const) {
    for (const value of query[name]) params.append(name, value);
  }
  if (query.postedWithin !== undefined) params.set("postedWithin", String(query.postedWithin));
  params.set("limit", String(PAGE_SIZE));
  if (offset > 0) params.set("cursor", encodeCursor(query, offset));

  const response = await answer(`/v1/search?${params}`, deps);
  if (!response.ok) throw new Error(`API ${response.status} for /v1/search`);
  const page = (await response.json()) as PublicSearchPage;
  return {
    hits: page.results,
    nextOffset: page.next === null ? null : offset + page.results.length,
    count: page.count,
    hasMore: page.hasMore,
    capped: page.capped,
    expanded: { locations: page.expandedLocations, remote: page.remote },
    asOf: page.asOf,
  };
}
