import type { APIRoute } from "astro";
import { upstream } from "@/lib/api";
import { NO_STORE, problem, readJsonBody } from "@/lib/http";

const MAX_BODY_BYTES = 256 * 1024;

const relay = (response: Response) =>
  new Response(response.body, {
    status: response.status,
    headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
  });

export const GET: APIRoute = async () => relay(await upstream("/v1/profile"));

/** Saves the resume and the (edited) profile markdown. The API validates sizes; this caps bytes first. */
export const PUT: APIRoute = async ({ request }) => {
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) return problem(read.status, read.error);
  return relay(
    await upstream("/v1/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(read.value),
    }),
  );
};
