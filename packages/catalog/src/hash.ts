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
export const gunzip = (data: Uint8Array): Promise<Uint8Array> =>
  pipe(data, new DecompressionStream("gzip"));
