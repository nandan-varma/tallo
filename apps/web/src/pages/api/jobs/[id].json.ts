import type { APIRoute } from "astro";
import { getJob } from "@/lib/api";

/** A same-origin detail endpoint for the hydrated master-detail browser. */
export const GET: APIRoute = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) return new Response("Not found", { status: 404 });
  const job = await getJob(id);
  return job
    ? Response.json(job, {
        headers: {
          // Browser reuse complements the Worker cache without making private
          // detail content eligible for shared HTTP caches.
          "cache-control": "private, max-age=300, stale-while-revalidate=60",
        },
      })
    : new Response("Not found", { status: 404 });
};
