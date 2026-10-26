import type { APIRoute } from "astro";
import { upstream } from "@/lib/api";
import { NO_STORE, problem, readJsonBody } from "@/lib/http";

/** The API caps the conversation at 512 KB; the proxy refuses anything larger before parsing. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Streams one assistant turn. The browser sends the whole conversation (the server keeps none) and gets
 * the AI SDK's UI message stream back unchanged, so tokens and tool calls arrive as they happen.
 */
export const POST: APIRoute = async ({ request }) => {
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) return problem(read.status, read.error);

  let response: Response;
  try {
    response = await upstream("/v1/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(read.value),
      signal: request.signal,
    });
  } catch {
    if (request.signal.aborted) return new Response(null, { status: 499, headers: NO_STORE });
    return problem(502, "The assistant could not be reached.");
  }

  // Pass the stream through with its protocol headers (content type, x-vercel-ai-ui-message-stream).
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-accel-buffering", "no");
  return new Response(response.body, { status: response.status, headers });
};
