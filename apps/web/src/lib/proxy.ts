import { upstream } from "@/lib/api";
import { NO_STORE, problem, readJsonBody } from "@/lib/http";

/** The default cap on a request body the browser sends to be relayed to the API. */
export const MAX_BODY_BYTES = 256 * 1024;

/** An API response handed to the browser as is, never cached. */
export const relay = (response: Response) =>
  new Response(response.body, {
    status: response.status,
    headers: {
      ...NO_STORE,
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    },
  });

/**
 * Relays a browser request to the API: the body is read with a byte cap, then sent on as JSON. The API
 * validates the content; this only keeps oversized or non-JSON bodies from reaching it.
 */
export async function forward(
  request: Request,
  path: string,
  { method = request.method, maxBytes = MAX_BODY_BYTES } = {},
): Promise<Response> {
  const read = await readJsonBody(request, maxBytes);
  if (!read.ok) return problem(read.status, read.error);
  return relay(
    await upstream(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(read.value),
      signal: request.signal,
    }),
  );
}
