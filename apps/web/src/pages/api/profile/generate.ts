import type { APIRoute } from "astro";
import { forward } from "@/lib/proxy";

/** Turns pasted resume text into profile markdown. Nothing is saved until the user saves. */
export const POST: APIRoute = ({ request }) => forward(request, "/v1/profile/generate");
