import type { APIRoute } from "astro";
import { problem } from "@/lib/http";
import { forward } from "@/lib/proxy";

const ACTIONS = new Set(["import", "tailor", "edit", "cover-letter", "fit"]);

/** The three AI calls: `import` (text to resume), `tailor` (resume to a posting) and `edit` (one instruction). */
export const POST: APIRoute = ({ request, params }) =>
  ACTIONS.has(params.action ?? "")
    ? forward(request, `/v1/resume/${params.action}`)
    : Promise.resolve(problem(404, "Not found"));
