import type { CreateRun, Finalize, FinalizeResult, JobFacts } from "@tallo/contracts";
import ky from "ky";

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
    sources: () =>
      client.get("v1/sources").json<{ id: string; lastCompleteRunAt: number | null }[]>(),
  };
}
export type Api = ReturnType<typeof createApi>;
