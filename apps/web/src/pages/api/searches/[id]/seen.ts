import type { APIRoute } from "astro";
import { upstream } from "@/lib/api";
import { problem } from "@/lib/http";
import { relay } from "@/lib/proxy";

const id = (value: string | undefined) => (value && /^\d+$/.test(value) ? value : null);

/** Marks a saved search as run now, so only roles posted after this count as new. */
export const POST: APIRoute = async ({ params }) => {
  const searchId = id(params.id);
  if (!searchId) return problem(404, "Not found");
  return relay(await upstream(`/v1/searches/${searchId}/seen`, { method: "POST" }));
};
