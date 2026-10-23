/** Content-addressed object storage. R2 in production, memory in tests. */
export interface BlobStore {
  has(key: string): Promise<boolean>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export const jdKey = (hash: string): string => `jd/${hash}`;
export const rawKey = (sourceId: string, runId: string): string => `raw/${sourceId}/${runId}.ndjson.gz`;

export function memoryBlobs(): BlobStore & { keys(): string[] } {
  const map = new Map<string, Uint8Array>();
  return {
    has: async (key) => map.has(key),
    put: async (key, bytes) => void map.set(key, bytes),
    get: async (key) => map.get(key) ?? null,
    delete: async (key) => void map.delete(key),
    keys: () => [...map.keys()],
  };
}
