import type { APIRoute } from "astro";
import { publicDeps } from "@/lib/api";
import { handlePublic } from "@/lib/public";

// The public proxy. Every method comes here: handlePublic serves the allowlisted GET paths and answers 404 or 405
// for everything else, so admin and ingest paths never reach the API.
export const ALL: APIRoute = ({ request }) => handlePublic(request, publicDeps());
