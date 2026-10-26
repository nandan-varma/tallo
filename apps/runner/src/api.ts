import type { CreateRun, Finalize, FinalizeResult, JobFacts } from "@tallo/contracts";
import ky from "ky";
import type { SourceState } from "./due.ts";

export interface ApplyResult {
  applied: number;
  missingBlobs: string[];
}

/** Typed client for the Tallo ingest API. Retries are handled by ky. */
export function createApi(baseUrl: string, token: string, fetchImpl?: typeof fetch) {
  const client = ky.create({
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    prefix: baseUrl.replace(/\/$/, ""),
    headers: { authorization: `Bearer ${token}` },
    timeout: 120_000,
    retry: { limit: 3, methods: ["get", "post", "put"] },
  });
  return {
    startRun: (run: CreateRun) => client.post("v1/runs", { json: run }).then(() => undefined),
    diff: (runId: string, postings: { id: string; hash: string }[]) =>
      client
        .post(`v1/runs/${runId}/diff`, { json: { postings } })
        .json<{ changed: string[] }>()
        .then((r) => r.changed),
    /** The server caps a check at 1000 hashes, so ask in chunks. */
    missingBlobs: async (hashes: string[]) => {
      const missing: string[] = [];
      for (let i = 0; i < hashes.length; i += 500) {
        const result = await client
          .post("v1/blobs/check", { json: { hashes: hashes.slice(i, i + 500) } })
          .json<{ missing: string[] }>();
        missing.push(...result.missing);
      }
      return missing;
    },
    putJd: (hash: string, gz: Uint8Array) =>
      client
        .put(`v1/blobs/jd/${hash}`, { body: gz as Uint8Array<ArrayBuffer> })
        .then(() => undefined),
    applyJobs: (runId: string, jobs: JobFacts[]) =>
      client.post(`v1/runs/${runId}/jobs`, { json: { jobs } }).json<ApplyResult>(),
    putRaw: (runId: string, gz: Uint8Array) =>
      client
        .put(`v1/runs/${runId}/raw`, { body: gz as Uint8Array<ArrayBuffer> })
        .json<{ key: string }>()
        .then((r) => r.key),
    finalize: (runId: string, body: Finalize) =>
      client.post(`v1/runs/${runId}/finalize`, { json: body }).json<FinalizeResult>(),
    reclassify: () => client.post("v1/admin/reclassify").json<{ updated: number; more: boolean }>(),
    dedupeBackfill: (after: number) =>
      client
        .post("v1/admin/dedupe/backfill", { searchParams: { after } })
        .json<{ updated: number; more: boolean; next: number }>(),
    dedupeRebuild: (full: boolean, after?: string) =>
      client
        .post("v1/admin/dedupe", { searchParams: { full, ...(after ? { after } : {}) } })
        .json<{ keys: number; changed: number; next: string | null }>(),
    sources: () => client.get("v1/sources").json<SourceState[]>(),
  };
}
export type Api = ReturnType<typeof createApi>;
