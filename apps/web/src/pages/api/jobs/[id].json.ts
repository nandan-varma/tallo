import type { APIRoute } from "astro";
import { getJob } from "@/lib/api";

/** A same-origin detail endpoint for the hydrated master-detail browser. */
export const GET: APIRoute = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) return new Response("Not found", { status: 404 });
  const job = await getJob(id);
  return job ? Response.json(job) : new Response("Not found", { status: 404 });
};
