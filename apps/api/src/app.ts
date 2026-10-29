import type { BlobStore, Db } from "@tallo/db";
import { IngestError } from "@tallo/db";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { adminRoutes } from "./admin.ts";
import { applicationRoutes } from "./applications.ts";
import { type AiAccess, assistantRoutes } from "./assistant.ts";
import type { CollectEnv } from "./collect.ts";
import { ingestRoutes } from "./ingest.ts";
import { jobRoutes } from "./jobs.ts";
import { resumeRoutes } from "./resume.ts";
import { searchRoutes } from "./searches.ts";

export interface Deps {
  db: Db;
  blobs: BlobStore;
  readToken: string;
  ingestToken: string;
  /** The model for a role; null or absent when AI is not configured. Called per request. */
  model?: AiAccess["model"];
  /** Today's token ceiling and ledger. Absent: the AI routes answer 503, so a missing guard never means no guard. */
  budget?: AiAccess["budget"];
  /** Collection environment for the staged-collect admin routes. Absent: those routes answer 503. */
  collect?: CollectEnv;
}

/** Internal API. Reads need READ_TOKEN; writes need INGEST_TOKEN (which may also read). */
export function createApp({ db, blobs, readToken, ingestToken, model, budget, collect }: Deps) {
  const app = new Hono();
  const ai = { model, budget };
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
  app.route("/", assistantRoutes({ db, blobs, read, ai }));
  app.route("/", applicationRoutes({ db, read }));
  app.route("/", searchRoutes({ db, read }));
  app.route("/", resumeRoutes({ db, blobs, read, ai }));
  app.route("/", ingestRoutes({ db, blobs, read, write }));
  app.route("/", adminRoutes({ db, write, ...(collect ? { collect } : {}) }));

  return app;
}
