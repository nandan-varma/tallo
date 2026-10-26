import type { APIRoute } from "astro";
import { upstream } from "@/lib/api";
import { NO_STORE, problem, readJsonBody } from "@/lib/http";

const MAX_BODY_BYTES = 256 * 1024;

/** Turns pasted resume text into profile markdown. Nothing is saved until the user saves. */
export const POST: APIRoute = async ({ request }) => {
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) return problem(read.status, read.error);
  const response = await upstream("/v1/profile/generate", {
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
