import type { APIRoute } from "astro";
import { upstream } from "@/lib/api";
import { relay } from "@/lib/proxy";

export const GET: APIRoute = async () => relay(await upstream("/v1/resumes"));
