import type { APIRoute } from "astro";
import { upstream } from "@/lib/api";
import { problem } from "@/lib/http";
import { relay } from "@/lib/proxy";

const id = (value: string | undefined) => (value && /^\d+$/.test(value) ? value : null);

export const DELETE: APIRoute = async ({ params }) => {
  const searchId = id(params.id);
  if (!searchId) return problem(404, "Not found");
  return relay(await upstream(`/v1/searches/${searchId}`, { method: "DELETE" }));
};
