import type { AiEnv } from "@tallo/ai";
import type { BlobStore } from "@tallo/db";
import { pruneRuns, purgeClosed, rebuildDuplicates, rebuildFacets, schema } from "@tallo/db";
import { drizzle } from "drizzle-orm/d1";
import { modelsFromEnv } from "./ai.ts";
import { createApp } from "./app.ts";

export interface Env extends AiEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
  READ_TOKEN: string;
  INGEST_TOKEN: string;
}

const r2 = (bucket: R2Bucket): BlobStore => ({
  has: async (key) => (await bucket.head(key)) !== null,
  put: async (key, bytes) => void (await bucket.put(key, bytes)),
  get: async (key) => {
    const object = await bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  },
  delete: (key) => bucket.delete(key),
});

const deps = (env: Env) => ({
  db: drizzle(env.DB, { schema }),
  blobs: r2(env.BLOBS),
  readToken: env.READ_TOKEN,
  ingestToken: env.INGEST_TOKEN,
  models: () => modelsFromEnv(env),
});

// The env object is stable for the life of an isolate, so build the app once per env.
const apps = new WeakMap<Env, ReturnType<typeof createApp>>();
const appFor = (env: Env) => {
  const cached = apps.get(env);
  if (cached) return cached;
  const app = createApp(deps(env));
  apps.set(env, app);
  return app;
};

export default {
  fetch: (request, env, ctx) => appFor(env).fetch(request, env, ctx),
  /**
   * Hourly housekeeping: drop jobs closed for 30+ days and their orphaned description blobs,
   * regroup duplicate postings, then refresh the facet counts (they count canonical rows only).
   */
  async scheduled(_event: ScheduledController, env: Env) {
    const { db, blobs } = deps(env);
    await purgeClosed(db, blobs);
    await pruneRuns(db, blobs);
    let next: string | null = "";
    while (next !== null) ({ next } = await rebuildDuplicates(db, undefined, { after: next }));
    await rebuildFacets(db);
  },
} satisfies ExportedHandler<Env>;
