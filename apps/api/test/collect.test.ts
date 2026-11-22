import { readFileSync } from "node:fs";
import { gunzip } from "@tallo/catalog";
import type { CollectMessage } from "@tallo/collect";
import type { SourceConfig } from "@tallo/contracts";
import { memoryBlobs, registerSources, schema, sourceConfig, startRun } from "@tallo/db";
import { testDb } from "@tallo/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import {
  type CollectEnv,
  enqueueDue,
  enqueueNamed,
  handleCollect,
  WORKER_MAX_RESPONSE_BYTES,
} from "../src/collect.ts";
import { INGEST, WRONG } from "./support.ts";

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

  it("sends claimed boards in batches of at most 100, the queue's limit", async () => {
    const { env, db, messages } = harness();
    const sizes: number[] = [];
    env.queue.sendBatch = async (batch) => {
      if (batch.length > 100) throw new Error("sendBatch accepts at most 100 messages");
      sizes.push(batch.length);
      messages.push(...batch.map((m) => m.body));
    };
    const boards = Array.from({ length: 250 }, (_, i) => ({
      ...stripe,
      id: `greenhouse:b${i}`,
      key: `b${i}`,
    }));
    await registerSources(db, boards, new Set());
    expect(await enqueueDue(env, 300)).toEqual({ enqueued: 250 });
    expect(sizes).toEqual([100, 100, 50]);
    expect(new Set(messages.map((m) => (m.kind === "start" ? m.sourceId : ""))).size).toBe(250);
  });

  it("never claims a board that needs the Mac's egress, by cron or by name", async () => {
    const { env, db, messages } = harness();
    const local = { ...stripe, id: "greenhouse:local", key: "local", params: { egress: "local" } };
    await registerSources(db, [stripe, local], new Set());
    expect(await enqueueDue(env, 10)).toEqual({ enqueued: 1 });
    expect(await enqueueNamed(env, [local.id])).toEqual({ enqueued: [] });
    expect(messages).toEqual([expect.objectContaining({ sourceId: stripe.id })]);
    expect(await dueOf(db, local.id)).toBe(0);
  });

  it("the kill switch stops the cron: nothing is claimed and nothing is enqueued", async () => {
    const { env, db, messages } = harness({ enabled: false });
    await registerSources(db, [stripe], new Set());
    expect(await enqueueDue(env, 10)).toEqual({ enqueued: 0 });
    expect(messages).toHaveLength(0);
    expect(await dueOf(db, stripe.id)).toBe(0);
  });

  it("named boards are collected now, with the cron off too (staged tests)", async () => {
    const { env, db, messages } = harness({ enabled: false });
    await registerSources(db, [stripe], new Set());
    expect(await enqueueNamed(env, [stripe.id, "greenhouse:nope"])).toEqual({
      enqueued: [stripe.id],
    });
    expect(messages).toHaveLength(1);
  });
});

describe("handleCollect", () => {
  // (The named-collect path ignores the kill switch; see the admin tests.)
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

  describe("scratch use", () => {
    /** Record every R2 put under work/ (the plan and raw parts), and every delete. */
    function spy(blobs: ReturnType<typeof memoryBlobs>) {
      const puts: string[] = [];
      const deletes: string[] = [];
      return {
        puts,
        deletes,
        wrapped: {
          ...blobs,
          put: async (key: string, bytes: Uint8Array) => {
            if (key.startsWith("work/")) puts.push(key);
            return blobs.put(key, bytes);
          },
          delete: async (key: string) => {
            deletes.push(key);
            return blobs.delete(key);
          },
        },
      };
    }
    const rawLines = async (blobs: ReturnType<typeof memoryBlobs>) => {
      const key = blobs.keys().find((k) => k.startsWith("raw/greenhouse:stripe/"))!;
      const gz = (await blobs.get(key))!;
      const text = new TextDecoder().decode(await gunzip(gz));
      return text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { id: string });
    };

    it("a run that finishes in one slice writes and deletes no plan or raw part", async () => {
      const h = harness();
      const s = spy(h.blobs);
      h.env.blobs = s.wrapped;
      await registerSources(h.db, [stripe], new Set());
      await handleCollect({ kind: "start", sourceId: stripe.id, runId: "run-cloud-0010" }, h.env);
      expect(s.puts).toEqual([]);
      expect(s.deletes).toEqual([]);
      expect(h.blobs.keys().filter((k) => k.startsWith("work/"))).toEqual([]);
      // The raw pack is still stored, with every posting.
      expect((await rawLines(h.blobs)).length).toBe(2);
      expect(h.logs.at(-1)).toMatchObject({ outcome: "complete", changed: 2 });
    });

    it("a run that continues stores its plan before the slice message, and cleans up at the end", async () => {
      const h = harness({ sliceSubrequests: 1 });
      const s = spy(h.blobs);
      h.env.blobs = s.wrapped;
      const seen: boolean[] = [];
      h.env.queue.send = async (body) => {
        // The plan must already be readable when the slice message exists.
        seen.push(h.blobs.keys().includes("work/run-cloud-0011/plan.json"));
        h.messages.push(body);
      };
      await registerSources(h.db, [stripe], new Set());
      await drain(h.env, h.messages, {
        kind: "start",
        sourceId: stripe.id,
        runId: "run-cloud-0011",
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(Boolean)).toBe(true);
      // One plan write per run (not per slice); no work/ key is left behind.
      expect(s.puts.filter((k) => k.endsWith("plan.json"))).toHaveLength(1);
      expect(h.blobs.keys().filter((k) => k.startsWith("work/"))).toEqual([]);
      expect(s.deletes).toContain("work/run-cloud-0011/plan.json");
      // The raw pack holds every posting, the early parts and the in-memory last one.
      expect((await rawLines(h.blobs)).map((l) => l.id).sort()).toHaveLength(2);
      const [run] = await h.db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, "run-cloud-0011"));
      expect(run?.status).toBe("complete");
    });

    it("a start message retried after the slice message failed to send still completes", async () => {
      const h = harness({ sliceSubrequests: 1 });
      const send = h.env.queue.send;
      let failed = false;
      h.env.queue.send = async (body) => {
        if (!failed) {
          failed = true;
          throw new Error("queue unavailable");
        }
        return send(body);
      };
      await registerSources(h.db, [stripe], new Set());
      const start: CollectMessage = {
        kind: "start",
        sourceId: stripe.id,
        runId: "run-cloud-0012",
      };
      await expect(handleCollect(start, h.env)).rejects.toThrow("queue unavailable");
      // The queue redelivers the same start message.
      await drain(h.env, h.messages, start);
      const [run] = await h.db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, "run-cloud-0012"));
      expect(run?.status).toBe("complete");
      // The failed attempt had already applied the first posting, so the retry's diff is smaller.
      expect(await h.db.select().from(schema.jobs)).toHaveLength(2);
    });
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
    // The board was due now; it is rescheduled, not left to be claimed again on the next tick.
    expect(await dueOf(db, stripe.id)).toBe(T + 15 * 60);
    expect(await dueOf(db, stripe.id)).toBeGreaterThan(T);
  });

  it("a board that no longer exists is skipped", async () => {
    const { env, logs } = harness();
    await handleCollect(
      { kind: "start", sourceId: "greenhouse:gone", runId: "run-gone-0001" },
      env,
    );
    expect(logs).toEqual([expect.objectContaining({ outcome: "skipped" })]);
  });

  it("a start for a board that needs local egress is skipped, and starts no run", async () => {
    const { env, db, logs } = harness();
    const local = { ...stripe, id: "greenhouse:local", key: "local", params: { egress: "local" } };
    await registerSources(db, [local], new Set());
    await handleCollect({ kind: "start", sourceId: local.id, runId: "run-local-0001" }, env);
    expect(logs).toEqual([expect.objectContaining({ outcome: "skipped", reason: "local egress" })]);
    expect(await db.select().from(schema.runs)).toHaveLength(0);
  });

  it("a redirect off the allowlist is a blocked run: logged as blocked, retried later, never dead", async () => {
    const { env, db, logs } = harness({
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://community.workday.com/x" },
        }),
    });
    await registerSources(db, [stripe], new Set());
    await handleCollect({ kind: "start", sourceId: stripe.id, runId: "run-cloud-0005" }, env);
    expect(logs).toEqual([expect.objectContaining({ outcome: "blocked" })]);
    expect(await dueOf(db, stripe.id)).toBe(T + 3600);
    const [row] = await db.select().from(schema.sources).where(eq(schema.sources.id, stripe.id));
    expect(row).toMatchObject({ status: "active", consecutiveFailures: 0, failureCount: 1 });
  });

  it("a listing body over the Worker's 16 MB cap is a blocked run, not read into memory", async () => {
    const huge = "x".repeat(WORKER_MAX_RESPONSE_BYTES + 1);
    const { env, db, logs } = harness({ fetch: async () => new Response(huge) });
    await registerSources(db, [stripe], new Set());
    await handleCollect({ kind: "start", sourceId: stripe.id, runId: "run-cloud-0006" }, env);
    expect(logs).toEqual([expect.objectContaining({ outcome: "blocked" })]);
    const [row] = await db.select().from(schema.sources).where(eq(schema.sources.id, stripe.id));
    expect(row).toMatchObject({ status: "active", failureCount: 1 });
  });

  it("a failed listing is a failed run: it closes nothing and does not throw", async () => {
    // A 400 is not retried (a 5xx would wait out the retry backoff in this test).
    const { env, db, logs } = harness({
      fetch: async () => new Response("", { status: 400 }),
    });
    await registerSources(db, [stripe], new Set());
    await handleCollect({ kind: "start", sourceId: stripe.id, runId: "run-cloud-0004" }, env);
    expect(logs).toEqual([expect.objectContaining({ outcome: "partial" })]);
    expect(await dueOf(db, stripe.id)).toBe(T + 3600);
  });

  it.each([403, 422])(
    "a first request answered %i is a failed run that backs off, not a flat retry",
    async (status) => {
      const { env, db, logs } = harness({ fetch: async () => new Response("", { status }) });
      await registerSources(db, [stripe], new Set());
      const runId = `run-first-${status}`;
      await handleCollect({ kind: "start", sourceId: stripe.id, runId }, env);
      expect(logs).toEqual([expect.objectContaining({ outcome: "partial" })]);
      expect(await dueOf(db, stripe.id)).toBe(T + 3600);
      // The second failure waits three hours, the third six, and the fourth a day.
      for (const [i, wait] of [[2, 3 * 3600] as const, [3, 6 * 3600] as const, [4, DAY] as const]) {
        await handleCollect({ kind: "start", sourceId: stripe.id, runId: `${runId}-${i}` }, env);
        expect(await dueOf(db, stripe.id)).toBe(T + wait);
      }
      const [row] = await db.select().from(schema.sources).where(eq(schema.sources.id, stripe.id));
      expect(row).toMatchObject({ status: "active", failureCount: 4 });
    },
  );
});

describe("admin routes", () => {
  function app(over: Partial<CollectEnv> = {}) {
    const h = harness(over);
    const application = createApp({
      db: h.db,
      blobs: h.blobs,
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
    expect(
      (await post(application, "/v1/admin/sources", { sources: [stripe] }, WRONG)).status,
    ).toBe(401);
    expect(
      (await post(application, "/v1/admin/collect", { sources: [stripe.id] }, WRONG)).status,
    ).toBe(401);
  });

  it("revives dead boards through the admin route, which needs the ingest token", async () => {
    const { application, db } = app();
    await registerSources(db, [stripe], new Set());
    await db
      .update(schema.sources)
      .set({ status: "dead", consecutiveFailures: 3, nextDueAt: T + 30 * DAY })
      .where(eq(schema.sources.id, stripe.id));
    const path = "/v1/admin/sources/revive";
    expect((await post(application, path, { sources: [stripe.id] }, WRONG)).status).toBe(401);
    const res = await post(application, path, { sources: [stripe.id, "greenhouse:nope"] });
    expect(await res.json()).toEqual({ revived: [stripe.id] });
    const [row] = await db.select().from(schema.sources).where(eq(schema.sources.id, stripe.id));
    expect(row).toMatchObject({ status: "active", consecutiveFailures: 0, nextDueAt: 0 });
  });

  it("retires only with the ingest token, an explicit dryRun and at most ten ids", async () => {
    const { application, db } = app();
    await registerSources(db, [stripe], new Set());
    const path = "/v1/admin/sources/retire";
    const body = { sources: [stripe.id], dryRun: true };

    expect((await post(application, path, body, WRONG)).status).toBe(401);
    expect((await post(application, path, { sources: [stripe.id] })).status).toBe(400);
    expect((await post(application, path, { sources: [stripe.id], dryRun: "yes" })).status).toBe(
      400,
    );
    expect(
      (
        await post(application, path, {
          sources: Array.from({ length: 11 }, (_, i) => `greenhouse:s${i}`),
          dryRun: true,
        })
      ).status,
    ).toBe(400);

    const preview = await post(application, path, body);
    expect(await preview.json()).toEqual({
      sources: [stripe.id],
      jobs: 0,
      rawKeys: [],
      orphanJdHashes: [],
      dryRun: true,
    });
    expect(await db.select().from(schema.sources)).toHaveLength(1);

    // Unknown ids are idempotent through the route too.
    const unknown = await post(application, path, {
      sources: ["greenhouse:nope"],
      dryRun: false,
    });
    expect(await unknown.json()).toMatchObject({ sources: [], jobs: 0, dryRun: false });
  });

  it("refuses a running source, then retires it through the admin route", async () => {
    const { application, db } = app();
    await registerSources(db, [stripe], new Set());
    const path = "/v1/admin/sources/retire";
    await startRun(
      db,
      { runId: "run-retire", source: stripe, runnerId: "mac", collectorVersion: "t", startedAt: T },
      T,
    );
    const busy = await post(application, path, { sources: [stripe.id], dryRun: false });
    expect(busy.status).toBe(409);
    expect(await db.select().from(schema.sources)).toHaveLength(1);

    await db.update(schema.runs).set({ status: "partial" }).where(eq(schema.runs.id, "run-retire"));
    const res = await post(application, path, { sources: [stripe.id], dryRun: false });
    expect(await res.json()).toEqual({
      sources: [stripe.id],
      jobs: 0,
      rawKeys: [],
      orphanJdHashes: [],
      dryRun: false,
    });
    expect(await db.select().from(schema.sources)).toHaveLength(0);
    // The historical run stays for audit.
    expect(await db.select().from(schema.runs)).toHaveLength(1);
  });

  it("staged collect enqueues named boards even while the cron is off", async () => {
    const off = app({ enabled: false });
    await registerSources(off.db, [stripe], new Set());
    const res = await post(off.application, "/v1/admin/collect", { sources: [stripe.id] });
    expect(await res.json()).toEqual({ requested: 1, enqueued: [stripe.id] });
    expect(off.messages).toHaveLength(1);
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

it("coordinates cloud Workday tenants through their shared pod gate", async () => {
  const reservations: string[] = [];
  const h = harness({
    reserve: async (host) => {
      reservations.push(host);
      return 0;
    },
    fetch: async () => Response.json({ total: 0, jobPostings: [], facets: [] }),
  });
  const source: SourceConfig = {
    id: "workday:acme/careers",
    platform: "workday",
    key: "acme/careers",
    company: "Acme",
    params: { wd: "wd1" },
  };
  await registerSources(h.db, [source], new Set());
  await handleCollect({ kind: "start", sourceId: source.id, runId: "run-cloud-pod-01" }, h.env);
  expect(reservations.length).toBeGreaterThan(0);
  expect(new Set(reservations)).toEqual(new Set(["wd1.myworkdayjobs.com"]));
});
