import { slug } from "@tallo/catalog";
import { LOCAL_EGRESS, leaseUntil, SCHEDULE, type SourceConfig, tierFor } from "@tallo/contracts";
import { and, eq, gt, sql } from "drizzle-orm";
import { batch, type Db } from "./db.ts";
import { runs, sources } from "./schema.ts";

/** Statements per D1 batch when registering boards (one statement per board). */
const REGISTER_BATCH = 100;

/**
 * Boards the cloud collector may claim: everything except those that need the Mac's egress
 * (`params.egress: "local"`). The runner's own sync does not use this; it collects every board.
 */
const cloudEligible = sql`json_extract(${sources.params}, '$.egress') IS NOT ${LOCAL_EGRESS}`;

export interface ClaimedSource {
  id: string;
  platform: string;
  key: string;
  company: string;
  params: Record<string, string | number | boolean>;
}

/**
 * Claim up to `limit` boards that are due. One statement: the subquery picks the most overdue
 * boards and the outer `WHERE` re-checks the due time, so two claimers never get the same board.
 * A claimed board is leased (its `next_due_at` moves to now + lease) until its run finalizes.
 */
export async function claimDue(db: Db, now: number, limit: number): Promise<ClaimedSource[]> {
  if (limit < 1) return [];
  return db
    .update(sources)
    .set({ nextDueAt: leaseUntil(now) })
    .where(
      sql`id IN (SELECT id FROM sources WHERE next_due_at <= ${now} AND ${cloudEligible} ORDER BY next_due_at LIMIT ${limit}) AND next_due_at <= ${now} AND ${cloudEligible}`,
    )
    .returning({
      id: sources.id,
      platform: sources.platform,
      key: sources.key,
      company: sources.company,
      params: sources.params,
    });
}

/**
 * Claim named boards regardless of their due time (the admin "collect these now" path). A board
 * with a running run is still refused later by `startRun`, so a claim here cannot double-collect.
 */
export async function claimSources(db: Db, ids: string[], now: number): Promise<ClaimedSource[]> {
  if (ids.length === 0) return [];
  // The ids travel as one JSON array, not one bound parameter each: D1 refuses a statement with more
  // than 100 bound parameters, and the admin path accepts up to 100 ids per call (as reviveSources does).
  return db
    .update(sources)
    .set({ nextDueAt: leaseUntil(now) })
    .where(
      and(
        sql`${sources.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
        cloudEligible,
      ),
    )
    .returning({
      id: sources.id,
      platform: sources.platform,
      key: sources.key,
      company: sources.company,
      params: sources.params,
    });
}

/**
 * A 409 `busy` (another run holds the board) is not a failure, but its message is acked, so the board must
 * not stay due: a due board is claimed again on the next tick and refused again. Move it to at least
 * `busyRetry` from now. A later schedule (the holding run's finalize, or a longer lease) is kept.
 */
export async function deferBusy(db: Db, sourceId: string, now: number): Promise<void> {
  await db
    .update(sources)
    .set({ nextDueAt: sql`max(${sources.nextDueAt}, ${now + SCHEDULE.busyRetry})` })
    .where(eq(sources.id, sourceId));
}

/**
 * Hourly repair. A board that is not dead is never scheduled further out than the longest policy
 * interval, so a due time beyond it can only be a bad write, and the board would not be collected for
 * months. Such boards are made due now. (A due board is claimed by the next five-minute tick, and a lease
 * ends within thirty minutes, so no other stuck state needs a repair.)
 */
export async function repairSchedule(db: Db, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const rows = await db
    .update(sources)
    .set({ nextDueAt: now })
    .where(and(eq(sources.status, "active"), gt(sources.nextDueAt, now + SCHEDULE.deadInterval)))
    .returning({ id: sources.id });
  return rows.length;
}

/** Read the config a claimed board needs to collect it. Null when the board was removed. */
export async function sourceConfig(db: Db, id: string): Promise<SourceConfig | null> {
  const row = (
    await db
      .select({
        id: sources.id,
        platform: sources.platform,
        key: sources.key,
        company: sources.company,
        params: sources.params,
      })
      .from(sources)
      .where(eq(sources.id, id))
      .limit(1)
  )[0];
  return row ?? null;
}

/**
 * Upsert the reviewed board configs (from `sources/*.json`) and the hot list. A new board is due
 * now. An existing board keeps its schedule, so re-registering never makes every board due at once.
 * Only the tier changes: a board that becomes hot is due now, so it is collected at the next tick.
 */
export async function registerSources(
  db: Db,
  configs: SourceConfig[],
  hot: ReadonlySet<string>,
): Promise<{ registered: number }> {
  const statements = configs.map((source) => {
    const tier = tierFor(hot.has(source.id));
    const fields = {
      platform: source.platform,
      key: source.key,
      company: source.company,
      companySlug: slug(source.company),
      params: source.params,
    };
    return db
      .insert(sources)
      .values({ id: source.id, ...fields, tier, nextDueAt: 0 })
      .onConflictDoUpdate({
        target: sources.id,
        set: {
          ...fields,
          tier,
          nextDueAt: sql`CASE WHEN ${tier} = 'hot' AND ${sources.tier} != 'hot' THEN 0 ELSE ${sources.nextDueAt} END`,
        },
      });
  });
  for (let i = 0; i < statements.length; i += REGISTER_BATCH) {
    const part = statements.slice(i, i + REGISTER_BATCH);
    if (part.length) await batch(db, part);
  }
  return { registered: configs.length };
}

/**
 * What the collector is doing and what is waiting: due boards by tier and platform, running runs
 * (the in-flight leases), and run outcomes in the last day. Read-only.
 */
export async function collectStatus(db: Db, now: number) {
  const due = await db
    .select({
      tier: sources.tier,
      platform: sources.platform,
      count: sql<number>`count(*)`,
    })
    .from(sources)
    .where(
      sql`${sources.nextDueAt} <= ${now} AND ${sources.status} = 'active' AND ${cloudEligible}`,
    )
    .groupBy(sources.tier, sources.platform);
  const dead = await db
    .select({ count: sql<number>`count(*)` })
    .from(sources)
    .where(eq(sources.status, "dead"));
  const inFlight = await db
    .select({ id: runs.id, sourceId: runs.sourceId, startedAt: runs.startedAt })
    .from(runs)
    .where(eq(runs.status, "running"))
    .limit(200);
  const day = await db
    .select({
      status: runs.status,
      count: sql<number>`count(*)`,
    })
    .from(runs)
    .where(gt(runs.startedAt, now - 86400))
    .groupBy(runs.status);
  return {
    dueNow: due.map((r) => ({ tier: r.tier, platform: r.platform, count: Number(r.count) })),
    dead: Number(dead[0]?.count ?? 0),
    inFlight: inFlight.map((r) => ({
      runId: r.id,
      sourceId: r.sourceId,
      startedAt: r.startedAt,
      ageSeconds: now - r.startedAt,
    })),
    last24h: Object.fromEntries(day.map((r) => [r.status, Number(r.count)])),
  };
}
