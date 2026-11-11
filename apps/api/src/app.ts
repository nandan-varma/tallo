import type { BlobStore, Db } from "@tallo/db";
import { IngestError } from "@tallo/db";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { adminRoutes } from "./admin.ts";
import type { CollectEnv } from "./collect.ts";
import { ingestRoutes } from "./ingest.ts";
import { publicRoutes } from "./public.ts";

export interface Deps {
  db: Db;
  blobs: BlobStore;
  ingestToken: string;
  /** Collection environment for the staged-collect admin routes. Absent: those routes answer 503. */
  collect?: CollectEnv;
}

/**
 * The API. Public reads (`/v1/search`, `/v1/jobs/:id`, `/v1/jobs/:id/description`) need no token. Everything else,
 * including the sources and runs reads, needs INGEST_TOKEN.
 */
export function createApp({ db, blobs, ingestToken, collect }: Deps) {
  const app = new Hono();
  const write = bearerAuth({ token: ingestToken });

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof IngestError) return c.json({ error: error.message }, error.status);
    console.error(error);
    return c.json({ error: "Internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/", publicRoutes({ db, blobs }));
  app.route("/", ingestRoutes({ db, blobs, write }));
  app.route("/", adminRoutes({ db, write, ...(collect ? { collect } : {}) }));

  return app;
}
