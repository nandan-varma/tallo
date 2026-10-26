import type { APIRoute } from "astro";
import { upstream } from "@/lib/api";
import { NO_STORE, problem, readJsonBody } from "@/lib/http";

/** Eight phrases and eight places fit in a few KB; anything bigger is not from the app. */
const MAX_BODY_BYTES = 16 * 1024;

/** One page of the database's answer to the assistant's search. No model involved. */
export const POST: APIRoute = async ({ request }) => {
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) return problem(read.status, read.error);
  const response = await upstream("/v1/jobs/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(read.value),
    signal: request.signal,
  });
  return new Response(response.body, {
    status: response.status,
    headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
  });
};
