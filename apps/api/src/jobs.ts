import { zValidator } from "@hono/zod-validator";
import { gunzip } from "@tallo/catalog";
import { searchPageSchema } from "@tallo/contracts";
import {
  type BlobStore,
  type Db,
  getJob,
  jdKey,
  listVariants,
  searchJobs,
  searchSchema,
} from "@tallo/db";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { searchPage } from "./jobs-port.ts";

/** Reads a posting's description from its gzipped blob in R2; null when the blob is gone. */
export const descriptionReader = (blobs: BlobStore) => async (jdHash: string) => {
  const blob = await blobs.get(jdKey(jdHash));
  return blob ? new TextDecoder().decode(await gunzip(blob)) : null;
};

/** Catalog reads, behind the read token. Only the search results page is uncacheable (it is per-query). */
export function jobRoutes({
  db,
  blobs,
  read,
}: {
  db: Db;
  blobs: BlobStore;
  read: MiddlewareHandler;
}) {
  const routes = new Hono();
  const descriptionOf = descriptionReader(blobs);

  routes.get("/v1/jobs", read, zValidator("query", searchSchema), async (c) => {
    c.header("cache-control", "private, max-age=30");
    return c.json(await searchJobs(db, c.req.valid("query")));
  });

  /** The results list: a page of the database's answer to a search spec (what the assistant searched for). */
  routes.post("/v1/jobs/search", read, zValidator("json", searchPageSchema), async (c) => {
    c.header("cache-control", "private, no-store");
    return c.json(await searchPage(db, c.req.valid("json")));
  });

  routes.get(
    "/v1/jobs/:id",
    read,
    zValidator("param", z.object({ id: z.coerce.number().int().positive() })),
    async (c) => {
      const job = await getJob(db, c.req.valid("param").id);
      if (!job) return c.json({ error: "Not found" }, 404);
      const { jdHash: _hash, sourceHash: _source, ...rest } = job;
      c.header("cache-control", "private, max-age=300");
      return c.json({
        ...rest,
        description: await descriptionOf(job.jdHash),
        variants: await listVariants(db, job),
      });
    },
  );

  return routes;
}
