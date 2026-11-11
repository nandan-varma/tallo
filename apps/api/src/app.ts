import type { BlobStore, Db } from "@tallo/db";
import { IngestError } from "@tallo/db";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { adminRoutes } from "./admin.ts";
import type { CollectEnv } from "./collect.ts";
import { ingestRoutes } from "./ingest.ts";
import { jobRoutes } from "./jobs.ts";

export interface Deps {
  db: Db;
  blobs: BlobStore;
  readToken: string;
  ingestToken: string;
  /** Collection environment for the staged-collect admin routes. Absent: those routes answer 503. */
  collect?: CollectEnv;
}

/** Internal API. Reads need READ_TOKEN; writes need INGEST_TOKEN (which may also read). */
export function createApp({ db, blobs, readToken, ingestToken, collect }: Deps) {
  const app = new Hono();
  const read = bearerAuth({ verifyToken: (t) => t === readToken || t === ingestToken });
  const write = bearerAuth({ token: ingestToken });

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof IngestError) return c.json({ error: error.message }, error.status);
    console.error(error);
    return c.json({ error: "Internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/", jobRoutes({ db, blobs, read }));
  app.route("/", ingestRoutes({ db, blobs, read, write }));
  app.route("/", adminRoutes({ db, write, ...(collect ? { collect } : {}) }));

  return app;
}
