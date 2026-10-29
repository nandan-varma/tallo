import { leaseUntil, type SourceConfig, tierFor } from "@tallo/contracts";
import { eq, gt, inArray, sql } from "drizzle-orm";
import { batch, type Db } from "./db.ts";
import { runs, sources } from "./schema.ts";

/** Statements per D1 batch when registering boards (one statement per board). */
const REGISTER_BATCH = 100;

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
      sql`id IN (SELECT id FROM sources WHERE next_due_at <= ${now} ORDER BY next_due_at LIMIT ${limit}) AND next_due_at <= ${now}`,
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
  return db
    .update(sources)
    .set({ nextDueAt: leaseUntil(now) })
    .where(inArray(sources.id, ids))
    .returning({
      id: sources.id,
      platform: sources.platform,
      key: sources.key,
      company: sources.company,
      params: sources.params,
    });
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

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

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
    .where(sql`${sources.nextDueAt} <= ${now} AND ${sources.status} = 'active'`)
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
