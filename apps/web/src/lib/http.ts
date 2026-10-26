export type JsonBodyRead =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 | 415; error: string };

const tooLarge = (maxBytes: number) =>
  `The request body is larger than ${Math.floor(maxBytes / 1024)} KB.`;

/**
 * Reads a request body as JSON with a hard byte cap. A declared Content-Length over the cap is rejected up
 * front, but the header is not trusted: bytes are counted as they stream in and the read stops (and cancels
 * the body) the moment the cap is passed.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBodyRead> {
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0] ?? "";
  if (mediaType.trim().toLowerCase() !== "application/json") {
    return { ok: false, status: 415, error: "Send the request as application/json." };
  }

  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { ok: false, status: 413, error: tooLarge(maxBytes) };
  }

  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, error: tooLarge(maxBytes) };
      }
      text += decoder.decode(value, { stream: true });
    }
  }
  text += decoder.decode();

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, error: "The request body must be JSON." };
  }
}

export const NO_STORE = { "cache-control": "private, no-store" } as const;

export const problem = (status: number, error: string) =>
  Response.json({ error }, { status, headers: NO_STORE });
