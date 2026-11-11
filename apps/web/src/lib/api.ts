import { env } from "cloudflare:workers";
import type { SearchPage, SearchSpec } from "@tallo/contracts";

/**
 * One request to the internal API with the read token: the service binding in production, `API_URL` in
 * local dev.
 */
export function upstream(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.READ_TOKEN}`);
  const request = { ...init, headers };
  return env.API
    ? env.API.fetch(new Request(`https://api.internal${path}`, request))
    : fetch(`${env.API_URL}${path}`, request);
}

/** One page of results for a search. Any non-2xx answer throws; the page shows a plain message. */
export async function runSearch(spec: SearchSpec, offset: number): Promise<SearchPage> {
  const response = await upstream("/v1/jobs/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...spec, offset, limit: PAGE_SIZE }),
  });
  if (!response.ok) throw new Error(`API ${response.status} for /v1/jobs/search`);
  return (await response.json()) as SearchPage;
}

export const PAGE_SIZE = 20;
