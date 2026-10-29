import type { Role } from "@tallo/ai";
import type { BlobStore } from "@tallo/db";
import { pruneRuns, purgeClosed, reapStaleRuns, rebuildDuplicates, schema } from "@tallo/db";
import { drizzle } from "drizzle-orm/d1";
import { type AiBindings, assistantBudget, assistantModel } from "./ai.ts";
import { createApp } from "./app.ts";

export interface Env extends AiBindings {
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
  model: (role: Role) => assistantModel(env, role),
  budget: () => assistantBudget(env),
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
   * Hourly housekeeping: mark runs abandoned by a killed collector as partial, drop jobs closed
   * for 30+ days and their orphaned description blobs, and regroup duplicate postings.
   */
  async scheduled(_event: ScheduledController, env: Env) {
    const { db, blobs } = deps(env);
    await reapStaleRuns(db);
    await purgeClosed(db, blobs);
    await pruneRuns(db, blobs);
    let next: string | null = "";
    while (next !== null) ({ next } = await rebuildDuplicates(db, undefined, { after: next }));
  },
} satisfies ExportedHandler<Env>;
