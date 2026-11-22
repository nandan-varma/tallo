import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { memoryBlobs, schema } from "@tallo/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { createApp } from "../src/app.ts";

// The other API tests run on a SQLite proxy. This one uses wrangler's local D1 (workerd, the same binding code path
// and drizzle's d1 driver as production), which is where a statement D1 refuses (#251's raw SQL batch item) shows.
const TOKEN = "ingest-token";
const MIGRATIONS = new URL("../../../packages/db/drizzle/", import.meta.url);
const source = {
  id: "greenhouse:acme",
  platform: "greenhouse",
  key: "acme",
  company: "Acme",
  params: {},
};

const persist = mkdtempSync(`${tmpdir()}/tallo-d1-`);
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: fileURLToPath(new URL("../wrangler.json", import.meta.url)),
    persist: { path: persist },
  });
  const { DB } = proxy.env;
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const statements = readFileSync(new URL(file, MIGRATIONS), "utf8")
      .split("--> statement-breakpoint")
      .filter((s) => s.trim());
    if (statements.length) await DB.batch(statements.map((s) => DB.prepare(s)));
  }
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
  rmSync(persist, { recursive: true, force: true });
});

it("starts and finalizes a run on a real D1 binding", async () => {
  const db = drizzle(proxy.env.DB, { schema });
  const app = createApp({ db, blobs: memoryBlobs(), ingestToken: TOKEN });
  const call = (path: string, json: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(json),
    });
  const now = Math.floor(Date.now() / 1000);
  const runId = "run-d1-real";

  const started = await call("/v1/runs", {
    runId,
    source,
    runnerId: "mac",
    collectorVersion: "t",
    startedAt: now,
  });
  expect(started.status).toBe(201);
  // A second start of a live source is refused, not a 500.
  const busy = await call("/v1/runs", {
    runId: "run-d1-second",
    source,
    runnerId: "mac",
    collectorVersion: "t",
    startedAt: now,
  });
  expect(busy.status).toBe(409);

  const finalized = await call(`/v1/runs/${runId}/finalize`, {
    seenIds: [],
    listingComplete: true,
    detailsComplete: true,
    emptyIsAuthoritative: true,
    requests: 1,
    finishedAt: now + 1,
    rawKey: null,
    issues: [],
  });
  expect(finalized.status).toBe(200);
  const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  expect(row?.status).toBe("complete");
});

it("lets exactly one of two concurrent starts claim a source", async () => {
  const db = drizzle(proxy.env.DB, { schema });
  const app = createApp({ db, blobs: memoryBlobs(), ingestToken: TOKEN });
  const start = (runId: string) =>
    app.request("/v1/runs", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        runId,
        source: { ...source, id: "greenhouse:race", key: "race" },
        runnerId: "mac",
        collectorVersion: "t",
        startedAt: Math.floor(Date.now() / 1000),
      }),
    });
  const statuses = (await Promise.all([start("run-race-a"), start("run-race-b")])).map(
    (r) => r.status,
  );
  expect(statuses.sort()).toEqual([201, 409]);
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.sourceId, "greenhouse:race"));
  expect(rows).toHaveLength(1);
});
