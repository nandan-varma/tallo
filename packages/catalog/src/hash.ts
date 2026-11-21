import stringify from "safe-stable-stringify";

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** Deterministic JSON (sorted keys, undefined dropped): equal data hashes equal. */
export const stableStringify = (value: unknown): string => stringify(value) ?? "null";

async function pipe(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const out = new Response(
    new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream),
  );
  return new Uint8Array(await out.arrayBuffer());
}

export const gzip = (data: Uint8Array): Promise<Uint8Array> =>
  pipe(data, new CompressionStream("gzip"));
/** The inflated bytes would exceed the caller's limit. A gzip bomb is refused, not inflated in full. */
export class GunzipLimitError extends Error {
  constructor(maxBytes: number) {
    super(`Decompressed size exceeds ${maxBytes} bytes`);
    this.name = "GunzipLimitError";
  }
}

/**
 * Inflates gzip data, stopping as soon as the output passes `maxBytes`. A small compressed input can inflate to
 * a very large output, so callers that accept untrusted input pass a limit.
 */
export async function gunzip(
  data: Uint8Array,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  const reader = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new GunzipLimitError(maxBytes);
    }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer());
}
