import { readFileSync } from "node:fs";
import type { CollectMessage } from "@tallo/collect";
import type { SourceConfig } from "@tallo/contracts";
import { memoryBlobs, registerSources, schema, sourceConfig, startRun } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { type CollectEnv, enqueueDue, enqueueNamed, handleCollect } from "../src/collect.ts";
import { INGEST, READ } from "./support.ts";

const fx = (name: string) =>
  readFileSync(
    new URL(`../../../packages/platforms/test/fixtures/${name}.json`, import.meta.url),
    "utf8",
  );
const T = 1_800_000_000;
const DAY = 86400;
const stripe: SourceConfig = {
  id: "greenhouse:stripe",
  platform: "greenhouse",
  key: "stripe",
  company: "Stripe",
  params: {},
};

/** Fake Greenhouse: list from the fixture, details from the pay-transparency fixture. */
const greenhouse = (): typeof fetch => async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname.endsWith("/jobs")) return new Response(fx("greenhouse-list"));
  return new Response(fx("greenhouse-detail"));
};

function harness(over: Partial<CollectEnv> = {}) {
  const db = testDb();
  const blobs = memoryBlobs();
  const messages: CollectMessage[] = [];
  const logs: Record<string, unknown>[] = [];
  const env: CollectEnv = {
    db,
    blobs,
    queue: {
      send: async (body) => void messages.push(body),
      sendBatch: async (batch) => void messages.push(...batch.map((m) => m.body)),
    },
    reserve: async () => 0,
    enabled: true,
    sliceSubrequests: 800,
    sliceMs: 300_000,
    version: "test",
    log: (line) => logs.push(line),
    fetch: greenhouse(),
    now: () => T * 1000,
    ...over,
  };
  return { env, db, blobs, messages, logs };
}

/** Run queued messages until none are left. Each message is one invocation. */
async function drain(env: CollectEnv, messages: CollectMessage[], first: CollectMessage) {
  await handleCollect(first, env);
  for (let i = 0; i < 50 && messages.length; i++) {
    const next = messages.shift()!;
    await handleCollect(next, env);
  }
  expect(messages).toHaveLength(0);
}

const dueOf = async (db: ReturnType<typeof testDb>, id: string) =>
  (
    await db
      .select({ nextDueAt: schema.sources.nextDueAt })
      .from(schema.sources)
      .where(eq(schema.sources.id, id))
  )[0]?.nextDueAt;

describe("the cron claim", () => {
  it("claims due boards once and enqueues one start message each", async () => {
    const { env, db, messages } = harness();
    await registerSources(db, [stripe], new Set());
    expect(await enqueueDue(env, 10)).toEqual({ enqueued: 1 });
    expect(messages).toEqual([
      expect.objectContaining({ kind: "start", sourceId: "greenhouse:stripe" }),
    ]);
    // The board is leased now: a second tick finds nothing and enqueues nothing.
    expect(await enqueueDue(env, 10)).toEqual({ enqueued: 0 });
    expect(messages).toHaveLength(1);
  });

  it("the kill switch stops the cron: nothing is claimed and nothing is enqueued", async () => {
    const { env, db, messages } = harness({ enabled: false });
    await registerSources(db, [stripe], new Set());
    expect(await enqueueDue(env, 10)).toEqual({ enqueued: 0 });
    expect(messages).toHaveLength(0);
    expect(await dueOf(db, stripe.id)).toBe(0);
  });

  it("named boards are collected now, and refused while the kill switch is off", async () => {
    const off = harness({ enabled: false });
    await registerSources(off.db, [stripe], new Set());
    expect(await enqueueNamed(off.env, [stripe.id])).toEqual({ enqueued: [] });

    const on = harness();
    await registerSources(on.db, [stripe], new Set());
    expect(await enqueueNamed(on.env, [stripe.id, "greenhouse:nope"])).toEqual({
      enqueued: [stripe.id],
    });
    expect(on.messages).toHaveLength(1);
  });
});

describe("handleCollect", () => {
  it("collects a board end to end, logs one line, and schedules the next run", async () => {
    const { env, db, blobs, messages, logs } = harness();
    await registerSources(db, [stripe], new Set());
    await handleCollect({ kind: "start", sourceId: stripe.id, runId: "run-cloud-0001" }, env);
    expect(messages).toHaveLength(0);
    expect(await dueOf(db, stripe.id)).toBe(T + 7 * DAY);
    expect(await db.select().from(schema.jobs)).toHaveLength(2);
    expect(blobs.keys().some((k) => k.startsWith("raw/greenhouse:stripe/"))).toBe(true);
    expect(logs).toEqual([
      expect.objectContaining({
        source: stripe.id,
        platform: "greenhouse",
        outcome: "complete",
        listed: 2,
        changed: 2,
        detailsComplete: true,
      }),
    ]);
  });

  it("a run split across slices finishes in order and closes once", async () => {
    // One subrequest per slice: every slice after the first hands its work back to the queue.
    const { env, db, messages, logs } = harness({ sliceSubrequests: 1 });
    await registerSources(db, [stripe], new Set());
    await drain(env, messages, { kind: "start", sourceId: stripe.id, runId: "run-cloud-0002" });
    const outcomes = logs.map((l) => l.outcome);
    expect(outcomes).toContain("continued");
    expect(outcomes.at(-1)).toBe("complete");
    const [run] = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, "run-cloud-0002"));
    expect(run?.status).toBe("complete");
    expect(await db.select().from(schema.jobs)).toHaveLength(2);
  });

  it("a board another run holds is acknowledged as busy, not failed", async () => {
    const { env, db, logs } = harness();
    await registerSources(db, [stripe], new Set());
    await startRun(
      db,
      {
        runId: "run-mac-000001",
        source: stripe,
        runnerId: "mac",
        collectorVersion: "t",
        startedAt: T,
      },
      T,
    );
    await expect(
      handleCollect({ kind: "start", sourceId: stripe.id, runId: "run-cloud-0003" }, env),
    ).resolves.toBeUndefined();
    expect(logs).toEqual([expect.objectContaining({ outcome: "busy" })]);
  });

  it("a board that no longer exists is skipped", async () => {
    const { env, logs } = harness();
    await handleCollect(
      { kind: "start", sourceId: "greenhouse:gone", runId: "run-gone-0001" },
      env,
    );
    expect(logs).toEqual([expect.objectContaining({ outcome: "skipped" })]);
  });

  it("a failed listing is a failed run: it closes nothing and does not throw", async () => {
    // A 400 is not retried (a 5xx would wait out the retry backoff in this test).
    const { env, db, logs } = harness({
      fetch: async () => new Response("", { status: 400 }),
    });
    await registerSources(db, [stripe], new Set());
    await handleCollect({ kind: "start", sourceId: stripe.id, runId: "run-cloud-0004" }, env);
    expect(logs).toEqual([expect.objectContaining({ outcome: "partial" })]);
    expect(await dueOf(db, stripe.id)).toBe(T + 6 * 3600);
  });
});

describe("admin routes", () => {
  function app(over: Partial<CollectEnv> = {}) {
    const h = harness(over);
    const application = createApp({
      db: h.db,
      blobs: h.blobs,
      readToken: READ,
      ingestToken: INGEST,
      collect: h.env,
    });
    return { ...h, application };
  }
  const post = (
    a: ReturnType<typeof app>["application"],
    path: string,
    body: unknown,
    token = INGEST,
  ) =>
    a.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("registers reviewed configs with their hot tier, and refuses a bad platform or key", async () => {
    const { application, db } = app();
    const ok = await post(application, "/v1/admin/sources", {
      sources: [stripe],
      hot: [stripe.id],
    });
    expect(ok.status).toBe(200);
    expect(await sourceConfig(db, stripe.id)).toMatchObject({ key: "stripe" });
    const [row] = await db.select().from(schema.sources);
    expect(row?.tier).toBe("hot");

    const badPlatform = await post(application, "/v1/admin/sources", {
      sources: [{ ...stripe, id: "nope:stripe", platform: "nope" }],
    });
    expect(badPlatform.status).toBe(400);
    const badId = await post(application, "/v1/admin/sources", {
      sources: [{ ...stripe, id: "greenhouse:other" }],
    });
    expect(badId.status).toBe(400);
  });

  it("requires the ingest token for every admin route", async () => {
    const { application } = app();
    expect((await post(application, "/v1/admin/sources", { sources: [stripe] }, READ)).status).toBe(
      401,
    );
    expect(
      (await post(application, "/v1/admin/collect", { sources: [stripe.id] }, READ)).status,
    ).toBe(401);
  });

  it("staged collect enqueues named boards, and answers 503 when the kill switch is off", async () => {
    const on = app();
    await registerSources(on.db, [stripe], new Set());
    const res = await post(on.application, "/v1/admin/collect", { sources: [stripe.id] });
    expect(await res.json()).toEqual({ requested: 1, enqueued: [stripe.id] });
    expect(on.messages).toHaveLength(1);

    const off = app({ enabled: false });
    expect(
      (await post(off.application, "/v1/admin/collect", { sources: [stripe.id] })).status,
    ).toBe(503);
  });

  it("status reports due counts, runs in flight and the last day", async () => {
    const { application, db } = app();
    await registerSources(db, [stripe], new Set());
    const res = await application.request("/v1/admin/collect/status", {
      headers: { authorization: `Bearer ${INGEST}` },
    });
    expect(await res.json()).toMatchObject({
      enabled: true,
      dueNow: [{ tier: "normal", platform: "greenhouse", count: 1 }],
      dead: 0,
      inFlight: [],
      last24h: {},
    });
  });
});
