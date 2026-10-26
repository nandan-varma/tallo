import type { APIRoute } from "astro";
import { upstream } from "@/lib/api";
import { forward, relay } from "@/lib/proxy";

/** `?job=<id>` picks the copy tailored to a posting; without it, the base resume. */
const path = (url: URL) => {
  const job = url.searchParams.get("job");
  return job && /^\d+$/.test(job) ? `/v1/resume?job=${job}` : "/v1/resume";
};

export const GET: APIRoute = async ({ url }) => relay(await upstream(path(url)));
export const PUT: APIRoute = ({ request, url }) => forward(request, path(url));
export const DELETE: APIRoute = async ({ url }) =>
  relay(await upstream(path(url), { method: "DELETE" }));
