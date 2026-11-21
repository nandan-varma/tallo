import type { BlobStore, Db } from "@tallo/db";
import { IngestError } from "@tallo/db";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { adminRoutes } from "./admin.ts";
import type { CollectEnv } from "./collect.ts";
import { ingestRoutes } from "./ingest.ts";
import { publicRoutes } from "./public.ts";

/** Drizzle wraps the binding error; inspect its cause without exposing query text to callers. */
function d1Overloaded(error: Error): boolean {
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++, cause = cause.cause) {
    if (
      /D1(?:_ERROR| DB)?.*(?:overloaded|too many resources consumed within a 10 second window)/i.test(
        cause.message,
      )
    )
      return true;
  }
  return false;
}

export interface Deps {
  db: Db;
  blobs: BlobStore;
  ingestToken: string;
  /** Host the public reads are refused on (see `publicRoutes`). Unset: allowed everywhere. */
  readsBlockedHost?: string;
  /** Collection environment for the staged-collect admin routes. Absent: those routes answer 503. */
  collect?: CollectEnv;
}

/**
 * The API. Public reads (`/v1/search`, `/v1/jobs/:id`, `/v1/jobs/:id/description`) need no token. Everything else,
 * including the sources and runs reads, needs INGEST_TOKEN.
 */
export function createApp({ db, blobs, ingestToken, readsBlockedHost, collect }: Deps) {
  const app = new Hono();
  const write = bearerAuth({ token: ingestToken });

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof IngestError) return c.json({ error: error.message }, error.status);
    console.error(error);
    if (d1Overloaded(error)) {
      c.header("Retry-After", "10");
      return c.json({ error: "Database busy; retry later" }, 503);
    }
    return c.json({ error: "Internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/", publicRoutes({ db, blobs, blockedHost: readsBlockedHost }));
  app.route("/", ingestRoutes({ db, blobs, write }));
  app.route("/", adminRoutes({ db, write, ...(collect ? { collect } : {}) }));

  return app;
}
