import type { APIRoute } from "astro";
import { askJobs } from "@/lib/api";
import { parseAskBody } from "@/lib/ask";

const NO_STORE = { "cache-control": "private, no-store" };

const problem = (status: number, error: string) =>
  Response.json({ error }, { status, headers: NO_STORE });

/**
 * Proxies one AI search to the API with the read token. The body is validated here and then
 * forwarded as-is; the profile is only ever sent on this request and is never stored server-side.
 */
export const POST: APIRoute = async ({ request }) => {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return problem(400, "The request body must be JSON.");
  }
  const body = parseAskBody(value);
  if (!body) {
    return problem(400, "Enter a query of up to 500 characters; the profile is limited to 20,000.");
  }

  let upstream: Response;
  try {
    upstream = await askJobs(JSON.stringify(body), request.signal);
  } catch {
    if (request.signal.aborted) return new Response(null, { status: 499, headers: NO_STORE });
    return problem(502, "The search service could not be reached.");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...NO_STORE,
      "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
    },
  });
};
