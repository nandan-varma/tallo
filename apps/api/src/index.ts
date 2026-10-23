import { purgeClosed, schema } from "@tallo/db";
import type { BlobStore } from "@tallo/db";
import { drizzle } from "drizzle-orm/d1";
import { createApp } from "./app.ts";

export interface Env {
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
});

const app = createApp<Env>(deps);

export default {
  fetch: app.fetch,
  /** Daily housekeeping: drop jobs closed for 30+ days and their orphaned description blobs. */
  async scheduled(_event: ScheduledController, env: Env) {
    const { db, blobs } = deps(env);
    await purgeClosed(db, blobs);
  },
} satisfies ExportedHandler<Env>;
