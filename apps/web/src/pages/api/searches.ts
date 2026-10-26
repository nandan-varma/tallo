import type { APIRoute } from "astro";
import { upstream } from "@/lib/api";
import { forward, relay } from "@/lib/proxy";

export const GET: APIRoute = async () => relay(await upstream("/v1/searches"));

/** Keeps a search (`{ name, spec }`). */
export const POST: APIRoute = ({ request }) => forward(request, "/v1/searches");
