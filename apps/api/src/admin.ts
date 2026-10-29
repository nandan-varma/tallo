import { zValidator } from "@hono/zod-validator";
import type { SourceConfig } from "@tallo/contracts";
import { collectStatus, type Db, registerSources } from "@tallo/db";
import { platformFor } from "@tallo/platforms";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type CollectEnv, enqueueNamed } from "./collect.ts";

const param = z.union([z.string(), z.number(), z.boolean()]);
const sourceSchema = z.object({
  id: z.string().min(3).max(200),
  platform: z.string().min(1).max(50),
  key: z.string().min(1).max(300),
  company: z.string().min(1).max(200),
  params: z.record(z.string(), param).default({}),
});

/** Reviewed board configs and the hot list, posted by `tallo register`. At most 500 per call. */
const registerSchema = z.object({
  sources: z.array(sourceSchema).min(1).max(500),
  hot: z.array(z.string().min(3).max(200)).max(500).default([]),
});
const collectSchema = z.object({
  sources: z.array(z.string().min(3).max(200)).min(1).max(100),
});

/**
 * Board registration and staged collection. Writes need the ingest token. Configs are trusted:
 * they come from the reviewed `sources/` files, never from a URL, and every platform validates its own.
 */
export function adminRoutes({
  db,
  write,
  collect,
}: {
  db: Db;
  write: MiddlewareHandler;
  collect?: CollectEnv;
}) {
  const routes = new Hono();

  routes.post("/v1/admin/sources", write, zValidator("json", registerSchema), async (c) => {
    const { sources, hot } = c.req.valid("json");
    const configs: SourceConfig[] = [];
    for (const source of sources) {
      if (source.id !== `${source.platform}:${source.key}`)
        return c.json({ error: `Source id must be ${source.platform}:${source.key}` }, 400);
      try {
        platformFor(source); // unknown platform, or a key the platform rejects
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Invalid source" }, 400);
      }
      configs.push(source);
    }
    return c.json(await registerSources(db, configs, new Set(hot)));
  });

  routes.post("/v1/admin/collect", write, zValidator("json", collectSchema), async (c) => {
    if (!collect) return c.json({ error: "Collection is not configured" }, 503);
    const { sources } = c.req.valid("json");
    const { enqueued } = await enqueueNamed(collect, sources);
    return c.json({ requested: sources.length, enqueued });
  });

  routes.get("/v1/admin/collect/status", write, async (c) => {
    const status = await collectStatus(db, Math.floor((collect?.now?.() ?? Date.now()) / 1000));
    return c.json({ enabled: collect?.enabled ?? false, ...status });
  });

  return routes;
}
