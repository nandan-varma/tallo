import type { APIRoute } from "astro";
import { upstream } from "@/lib/api";
import { forward, relay } from "@/lib/proxy";

export const GET: APIRoute = async () => relay(await upstream("/v1/profile"));

/** Saves the resume and the (edited) profile markdown. The API validates sizes; this caps bytes first. */
export const PUT: APIRoute = ({ request }) => forward(request, "/v1/profile");
