import type { APIRoute } from "astro";
import { upstream } from "@/lib/api";
import { problem } from "@/lib/http";
import { forward, relay } from "@/lib/proxy";

const id = (value: string | undefined) => (value && /^\d+$/.test(value) ? value : null);

/** Tracks a role, or moves it to another status (`{ status, note? }`). */
export const PUT: APIRoute = ({ request, params }) => {
  const jobId = id(params.jobId);
  return jobId
    ? forward(request, `/v1/applications/${jobId}`)
    : Promise.resolve(problem(404, "Not found"));
};

export const DELETE: APIRoute = async ({ params }) => {
  const jobId = id(params.jobId);
  if (!jobId) return problem(404, "Not found");
  return relay(await upstream(`/v1/applications/${jobId}`, { method: "DELETE" }));
};
