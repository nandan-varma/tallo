/** What a person is told when a request fails and the server gave no better reason. */
const GENERIC = "Something went wrong. Try again.";

async function reason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Not JSON: fall through to the generic messages.
  }
  return response.status === 503 ? "The assistant isn't set up on the server yet." : GENERIC;
}

/**
 * One JSON request to this app's own `/api` routes. Resolves with the parsed body (`null` for 204) and
 * rejects with an Error whose message is fit to show to the person.
 */
export async function requestJson<T>(
  url: string,
  { method = "GET", body, signal }: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Can't reach the server. Check your connection.");
  }
  if (!response.ok) throw new Error(await reason(response));
  return response.status === 204 ? (null as T) : ((await response.json()) as T);
}

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : GENERIC);
