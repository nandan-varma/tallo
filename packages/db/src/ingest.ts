import type { CreateRun, Finalize, FinalizeResult, JobFacts } from "@tallo/contracts";
import {
  CLOSE_AFTER_ABSENT_RUNS,
  DEAD_AFTER_NOT_FOUND_RUNS,
  nextDueAt,
  type RunOutcome,
  STALE_HIDE_DAYS,
} from "@tallo/contracts";
import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { alias } from "drizzle-orm/sqlite-core";
import type { BlobStore } from "./blobs.ts";
import { jdKey, rawKey } from "./blobs.ts";
import type { Db } from "./db.ts";
import { batch, CHUNK, chunks } from "./db.ts";
import { jobs, regroupState, runs, sources } from "./schema.ts";

export class IngestError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

const RUN_LEASE_SECONDS = 2 * 60 * 60;
/** Description hashes checked per purge lookup (one statement each). */
const HASH_CHUNK = 100;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const jsonIds = (ids: readonly (string | number)[]) =>
  sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;

async function run(db: Db, runId: string) {
  const row = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0];
  if (!row) throw new IngestError(404, `Unknown run ${runId}`);
  return row;
}

/** Idempotent on runId. One running run per source at a time (a stale one is superseded). */
export async function startRun(db: Db, input: CreateRun, now = nowSeconds()): Promise<void> {
  const existing = (await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1))[0];
  if (existing) return;
  const busy = (
    await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.sourceId, input.source.id),
          eq(runs.status, "running"),
          sql`${runs.startedAt} > ${now - RUN_LEASE_SECONDS}`,
        ),
      )
      .limit(1)
  )[0];
  if (busy) throw new IngestError(409, `Source ${input.source.id} is already running (${busy.id})`);
  const { source } = input;
  const fields = {
    platform: source.platform,
    key: source.key,
    company: source.company,
    companySlug: slug(source.company),
    params: source.params,
    lastRunAt: now,
  };
  await batch(db, [
    db
      .insert(sources)
      .values({ id: source.id, ...fields })
      .onConflictDoUpdate({ target: sources.id, set: fields }),
    db.insert(runs).values({
      id: input.runId,
      sourceId: source.id,
      runnerId: input.runnerId,
      collectorVersion: input.collectorVersion,
      startedAt: input.startedAt,
      status: "running",
    }),
  ]);
}

/** Which listed postings are new or changed. Pure read: nothing is written. */
export async function diff(
  db: Db,
  runId: string,
  postings: { id: string; hash: string }[],
): Promise<string[]> {
  const { sourceId } = await run(db, runId);
  const known = new Map(
    (
      await db
        .select({ id: jobs.postingId, hash: jobs.sourceHash })
        .from(jobs)
        .where(eq(jobs.sourceId, sourceId))
    ).map((r) => [r.id, r.hash]),
  );
  return postings.filter((p) => known.get(p.id) !== p.hash).map((p) => p.id);
}

export interface ApplyResult {
  applied: number;
  /** JD blobs the runner must upload before these postings can be applied. */
  missingBlobs: string[];
}

/** Equal as stored. JSON columns compare by value, since they come back parsed. */
const same = (stored: unknown, next: unknown) =>
  stored === next ||
  (typeof next === "object" && next !== null && JSON.stringify(stored) === JSON.stringify(next));

/**
 * Upsert a batch of jobs. Postings whose JD blob is not stored yet are skipped and reported.
 * A stored row is rewritten only in the columns that changed: SQLite rewrites every index and fires every
 * `AFTER UPDATE OF` trigger for a column named in SET, even when its value is the same. An unchanged posting
 * therefore costs nothing here, and a changed one costs its changed columns and the indexes they belong to.
 */
export async function applyJobs(
  db: Db,
  blobs: BlobStore,
  runId: string,
  incoming: JobFacts[],
  now = nowSeconds(),
): Promise<ApplyResult> {
  const { sourceId } = await run(db, runId);
  const source = (await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1))[0];
  if (!source) throw new IngestError(404, `Unknown source ${sourceId}`);

  // One row per posting, the last one sent (what sequential upserts would leave behind).
  const latest = [...new Map(incoming.map((j) => [j.postingId, j])).values()];
  const stored = new Map(
    (
      await db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.sourceId, sourceId),
            sql`${jobs.postingId} IN ${jsonIds(latest.map((j) => j.postingId))}`,
          ),
        )
    ).map((r) => [r.postingId, r]),
  );
  // A stored row's description is in R2 by invariant (purge keeps every blob a row references), so a
  // description equal to the stored jd_hash needs no existence check.
  const known = new Set(
    latest.filter((j) => stored.get(j.postingId)?.jdHash === j.jdHash).map((j) => j.jdHash),
  );
  const hashes = [...new Set(latest.map((j) => j.jdHash))];
  const found = await Promise.all(
    hashes.filter((h) => !known.has(h)).map(async (h) => ((await blobs.has(jdKey(h))) ? h : null)),
  );
  const present = new Set([...known, ...found.filter((h): h is string => !!h)]);
  const ready = latest.filter((j) => present.has(j.jdHash));
  const missingBlobs = hashes.filter((h) => !present.has(h));
  if (ready.length === 0) return { applied: 0, missingBlobs };

  const added = ready.filter((j) => !stored.has(j.postingId)).length;

  const upserts: BatchItem<"sqlite">[] = [];
  for (const j of ready) {
    const { postingId, facts, ...columns } = j;
    const values = {
      ...columns,
      sourceId,
      postingId,
      facts,
      company: source.company,
      companySlug: source.companySlug,
      sortAt: j.postedAt ?? now,
      firstSeenAt: now,
      updatedAt: now,
    };
    const target = [jobs.sourceId, jobs.postingId];
    const prior = stored.get(postingId);
    if (!prior) {
      // New, or inserted by a concurrent run since the read: the conflict path keeps the first seen time.
      const { firstSeenAt: _keep, ...update } = values;
      upserts.push(
        db
          .insert(jobs)
          .values(values)
          .onConflictDoUpdate({
            target,
            set: {
              ...update,
              sortAt: sql`coalesce(${j.postedAt}, ${jobs.firstSeenAt})`,
              absentRuns: 0,
              closedAt: null,
            },
          }),
      );
      continue;
    }
    const next: Record<string, unknown> = {
      ...columns,
      facts,
      company: source.company,
      companySlug: source.companySlug,
      sortAt: j.postedAt ?? prior.firstSeenAt,
      absentRuns: 0,
      closedAt: null,
    };
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      if (!same((prior as Record<string, unknown>)[key], value)) set[key] = value;
    }
    if (Object.keys(set).length === 0) continue;
    // Duplicate groups are rebuilt from rows written in the window: a changed dedupe key or a reopen moves
    // the row between groups, so it bumps updated_at. Other changes leave the grouping alone.
    if ("dedupeKey" in set || set.closedAt === null) set.updatedAt = now;
    upserts.push(db.insert(jobs).values(values).onConflictDoUpdate({ target, set }));
  }
  const counters = db
    .update(runs)
    .set({
      added: sql`${runs.added} + ${added}`,
      changed: sql`${runs.changed} + ${ready.length - added}`,
    })
    .where(eq(runs.id, runId));
  // Jobs are visible as soon as they land, even if the run never finalizes.
  const listed = db
    .update(sources)
    .set({ lastListedAt: sql`coalesce(${sources.lastListedAt}, ${now})` })
    .where(eq(sources.id, sourceId));
  await batch(db, [...upserts, counters, listed]);
  return { applied: ready.length, missingBlobs };
}

/**
 * Closes the run. Only a complete, non-empty (or authoritatively empty) listing may age out
 * jobs: a failed or partial run never proves anything disappeared.
 */
export async function finalize(
  db: Db,
  runId: string,
  fin: Finalize,
  now = nowSeconds(),
): Promise<FinalizeResult> {
  const current = await run(db, runId);
  if (current.status !== "running") {
    return {
      status: current.status === "complete" ? "complete" : "partial",
      closureApplied: current.closed !== null,
      closed: current.closed ?? 0,
      reopened: current.reopened ?? 0,
    };
  }
  // Read before the batch advances last_listed_at: a stale source that lists again un-hides its rows.
  const [before] = await db
    .select({
      lastListedAt: sources.lastListedAt,
      status: sources.status,
      tier: sources.tier,
      consecutiveFailures: sources.consecutiveFailures,
    })
    .from(sources)
    .where(eq(sources.id, current.sourceId))
    .limit(1);
  const wasStale = (before?.lastListedAt ?? 0) < now - STALE_HIDE_DAYS * 86400;
  const closureApplied =
    fin.listingComplete && (fin.seenIds.length > 0 || fin.emptyIsAuthoritative);
  let closed = 0;
  let reopened = 0;
  const statements: BatchItem<"sqlite">[] = [];

  if (closureApplied) {
    const seen = new Set(fin.seenIds);
    const open = await db
      .select({
        id: jobs.id,
        postingId: jobs.postingId,
        absentRuns: jobs.absentRuns,
        closedAt: jobs.closedAt,
      })
      .from(jobs)
      .where(eq(jobs.sourceId, current.sourceId));
    const back = open.filter(
      (j) => seen.has(j.postingId) && (j.absentRuns > 0 || j.closedAt !== null),
    );
    const reopening = back.filter((j) => j.closedAt !== null);
    const recovering = back.filter((j) => j.closedAt === null);
    const gone = open.filter((j) => !seen.has(j.postingId) && j.closedAt === null);
    const closing = gone.filter((j) => j.absentRuns + 1 >= CLOSE_AFTER_ABSENT_RUNS);
    const absent = gone.filter((j) => j.absentRuns + 1 < CLOSE_AFTER_ABSENT_RUNS);
    reopened = reopening.length;
    closed = closing.length;
    // Only rows that change group (closing, reopening) bump updated_at, which is what the regroup reads.
    // The other rows get the counter alone: a first absence or a recovery does not change any group.
    for (const ids of chunks(
      reopening.map((j) => j.id),
      CHUNK,
    )) {
      statements.push(
        db
          .update(jobs)
          .set({ absentRuns: 0, closedAt: null, updatedAt: now })
          .where(sql`${jobs.id} IN ${jsonIds(ids)}`),
      );
    }
    for (const ids of chunks(
      recovering.map((j) => j.id),
      CHUNK,
    )) {
      statements.push(
        db
          .update(jobs)
          .set({ absentRuns: 0 })
          .where(sql`${jobs.id} IN ${jsonIds(ids)}`),
      );
    }
    for (const ids of chunks(
      closing.map((j) => j.id),
      CHUNK,
    )) {
      statements.push(
        db
          .update(jobs)
          .set({
            absentRuns: sql`${jobs.absentRuns} + 1`,
            closedAt: sql`CASE WHEN ${jobs.absentRuns} + 1 >= ${CLOSE_AFTER_ABSENT_RUNS} THEN ${now} END`,
            // A closing canonical hands its group over: bump updated_at so the rebuild sees it.
            updatedAt: now,
          })
          .where(sql`${jobs.id} IN ${jsonIds(ids)}`),
      );
    }
    for (const ids of chunks(
      absent.map((j) => j.id),
      CHUNK,
    )) {
      statements.push(
        db
          .update(jobs)
          .set({ absentRuns: sql`${jobs.absentRuns} + 1` })
          .where(sql`${jobs.id} IN ${jsonIds(ids)}`),
      );
    }
  }
  const status = fin.listingComplete ? "complete" : "partial";
  // A listing that returned (complete, or any postings seen) counts for freshness; a failed one does not.
  const listed = fin.listingComplete || fin.seenIds.length > 0;
  // Board health. Only a successful listing resets the not-found streak and revives a dead board.
  // A board-not-found run adds to the streak. Any other failure says nothing about whether the
  // board exists, so it leaves the streak as it is: a timeout between two 404s must not hide them.
  // `consecutive_failures` holds that streak.
  const health = fin.listingComplete
    ? { consecutiveFailures: 0, status: "active" as const, lastCompleteRunAt: now }
    : fin.boardNotFound
      ? {
          consecutiveFailures: sql`${sources.consecutiveFailures} + 1`,
          status: sql`CASE WHEN ${sources.consecutiveFailures} + 1 >= ${DEAD_AFTER_NOT_FOUND_RUNS} THEN 'dead' ELSE ${sources.status} END`,
        }
      : {};
  statements.push(
    db
      .update(runs)
      .set({
        status,
        finishedAt: fin.finishedAt,
        requests: fin.requests,
        seen: fin.seenIds.length,
        closed: closureApplied ? closed : null,
        reopened: closureApplied ? reopened : null,
        rawKey: current.rawKey ?? fin.rawKey,
        issues: fin.issues,
      })
      .where(eq(runs.id, runId)),
    db
      .update(sources)
      .set({
        lastStatus: status,
        ...health,
        ...(listed ? { lastListedAt: now } : {}),
        nextDueAt: nextDueAt({
          tier: before?.tier ?? "normal",
          outcome: runOutcome(fin, before),
          finishedAt: fin.finishedAt,
        }),
      })
      .where(eq(sources.id, current.sourceId)),
  );
  await batch(db, statements);
  // A listing that brings a stale source back changes every group its rows belong to, not only the
  // rows written in this run, so all of the source's keys are regrouped. Otherwise only a run that
  // wrote something a group depends on (rows added or changed, closures, reopens) needs a regroup.
  const recovered = listed && wasStale;
  const grouped = current.added + current.changed + closed + reopened > 0;
  if (recovered || grouped) await regroupSource(db, current.sourceId, now, recovered);
  return { status, closureApplied, closed, reopened };
}

/**
 * How the run ends for scheduling. A 404 streak that reaches the dead threshold (or a board already
 * dead and still failing) is `dead`; any other failure is `partial`.
 */
function runOutcome(
  fin: Pick<Finalize, "listingComplete" | "boardNotFound">,
  before: { status: string; consecutiveFailures: number } | undefined,
): RunOutcome {
  if (fin.listingComplete) return "complete";
  const dead =
    before?.status === "dead" ||
    (fin.boardNotFound && (before?.consecutiveFailures ?? 0) + 1 >= DEAD_AFTER_NOT_FOUND_RUNS);
  return dead ? "dead" : "partial";
}

/**
 * Marks runs still `running` past the lease as partial: the collector died before it could finalize.
 * It closes nothing (a partial run never proves a posting is gone) and leaves board health alone.
 * A late finalize from the dead collector is then a no-op, because the run is no longer running.
 */
export async function reapStaleRuns(db: Db, now = nowSeconds()): Promise<number> {
  const stale = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.status, "running"), lt(runs.startedAt, now - RUN_LEASE_SECONDS)))
    .limit(1000);
  for (const ids of chunks(
    stale.map((r) => r.id),
    CHUNK,
  )) {
    await db
      .update(runs)
      .set({
        status: "partial",
        finishedAt: now,
        issues: [{ code: "stopped", message: "Collector process stopped before finalize" }],
      })
      .where(sql`${runs.id} IN ${jsonIds(ids)}`);
  }
  return stale.length;
}

/**
 * Regroups the keys this source's finalize can change, so its closures, reopens and freshness take
 * effect now instead of at the next hourly pass. Normally that is the keys of the rows
 * written in the window (the run just wrote them). When the source comes back from stale, it is every
 * key the source has. Writes only rows whose `dup_of` changes.
 */
async function regroupSource(
  db: Db,
  sourceId: string,
  now: number,
  recovered: boolean,
): Promise<number> {
  const rows = await db
    .selectDistinct({ key: jobs.dedupeKey })
    .from(jobs)
    .where(
      and(
        eq(jobs.sourceId, sourceId),
        isNotNull(jobs.dedupeKey),
        recovered ? undefined : gte(jobs.updatedAt, now - DEDUPE_WINDOW),
      ),
    );
  const keys = rows.flatMap((r) => (r.key === null ? [] : [r.key]));
  return regroup(db, keys, now - STALE_HIDE_DAYS * 86400);
}

/** Delete jobs closed for over `days`, then any JD blob no remaining job references. */
export async function purgeClosed(
  db: Db,
  blobs: BlobStore,
  days = 30,
  now = nowSeconds(),
): Promise<number> {
  const stale = await db
    .select({ id: jobs.id, jdHash: jobs.jdHash })
    .from(jobs)
    .where(sql`${jobs.closedAt} IS NOT NULL AND ${jobs.closedAt} < ${now - days * 86400}`)
    .limit(1000);
  for (const ids of chunks(
    stale.map((j) => j.id),
    CHUNK,
  )) {
    await db.delete(jobs).where(sql`${jobs.id} IN ${jsonIds(ids)}`);
  }
  // One lookup per HASH_CHUNK hashes (jobs_jd_hash_idx), not one per hash.
  for (const part of chunks([...new Set(stale.map((j) => j.jdHash))], HASH_CHUNK)) {
    const used = new Set(
      (
        await db
          .selectDistinct({ hash: jobs.jdHash })
          .from(jobs)
          .where(sql`${jobs.jdHash} IN ${jsonIds(part)}`)
      ).map((r) => r.hash),
    );
    for (const hash of part) if (!used.has(hash)) await blobs.delete(jdKey(hash));
  }
  return stale.length;
}

/** Record intent before uploading so an interrupted upload remains discoverable by cleanup. */
export async function storeRawPack(
  db: Db,
  blobs: BlobStore,
  runId: string,
  bytes: Uint8Array,
): Promise<string> {
  const current = await run(db, runId);
  const key = rawKey(current.sourceId, current.id);
  await db.update(runs).set({ rawKey: key, rawUploaded: 0 }).where(eq(runs.id, runId));
  await blobs.put(key, bytes);
  await db.update(runs).set({ rawUploaded: 1 }).where(eq(runs.id, runId));
  return key;
}

/**
 * Keep two finalized raw packs per source. Their rows stay as blob references even
 * after 30 days; all other expired runs (including abandoned runs) are removed.
 * Delete blobs before clearing references so a failed delete can be retried.
 */
export async function pruneRuns(
  db: Db,
  blobs: BlobStore,
  now = nowSeconds(),
): Promise<{ packs: number; runs: number }> {
  const obsolete = await obsoleteRuns(db, now);
  for (const page of chunks(obsolete, CHUNK)) {
    for (const row of page) await blobs.delete(row.rawKey!);
    await db
      .update(runs)
      .set({ rawKey: null })
      .where(sql`${runs.id} IN ${jsonIds(page.map((row) => row.id))}`);
  }
  const expired = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(lt(runs.startedAt, now - RUN_RETENTION_SECONDS), isNull(runs.rawKey)))
    .limit(1000);
  for (const ids of chunks(
    expired.map((row) => row.id),
    CHUNK,
  )) {
    await db.delete(runs).where(sql`${runs.id} IN ${jsonIds(ids)}`);
  }
  return { packs: obsolete.length, runs: expired.length };
}

const RUN_RETENTION_SECONDS = 30 * 86400;

/**
 * The two selects of `obsoleteRuns`. Packs to delete: those past the two newest per source, and those of runs
 * abandoned or never uploaded, once they are 30 days old. Two index-driven selects, not one OR: the age branch
 * seeks runs_started_idx and the superseded branch reads only runs_pack_idx. The predicates match that partial
 * index's WHERE exactly (literals, not parameters), so SQLite can use it.
 */
export function obsoleteRunQueries(db: Db, now: number) {
  const retained = sql`(
    SELECT id FROM (
      SELECT id, row_number() OVER (
        PARTITION BY source_id ORDER BY started_at DESC, id DESC
      ) AS rank
      FROM runs WHERE raw_key IS NOT NULL AND raw_uploaded = 1 AND status != 'running'
    ) WHERE rank <= 2
  )`;
  const aged = db
    .select({ id: runs.id, rawKey: runs.rawKey })
    .from(runs)
    .where(
      and(
        isNotNull(runs.rawKey),
        sql`(${runs.status} = 'running' OR ${runs.rawUploaded} = 0)`,
        lt(runs.startedAt, now - RUN_RETENTION_SECONDS),
      ),
    )
    .limit(1000);
  const superseded = db
    .select({ id: runs.id, rawKey: runs.rawKey })
    .from(runs)
    .where(
      and(
        sql`${runs.rawKey} IS NOT NULL AND ${runs.rawUploaded} = 1 AND ${runs.status} != 'running'`,
        sql`${runs.id} NOT IN ${retained}`,
      ),
    )
    .limit(1000);
  return [aged, superseded] as const;
}

/** Packs to delete, at most 1,000 (see `obsoleteRunQueries`). */
export async function obsoleteRuns(db: Db, now: number) {
  const [aged, superseded] = await Promise.all(obsoleteRunQueries(db, now));
  const byId = new Map([...aged, ...superseded].map((row) => [row.id, row]));
  return [...byId.values()].slice(0, 1000);
}

/**
 * Fills `dedupe_key` for rows stored before the key existed, from their stored company, title and
 * jd_hash (no refetching). Pages by id (`after` = the last id of the previous page), so each call
 * reads only the rows it fills. Does not regroup: run `rebuildDuplicates({ full: true })` afterwards.
 */
export async function backfillDedupeKeys(
  db: Db,
  keyOf: (row: { company: string; title: string; jdHash: string }) => Promise<string>,
  { after = 0, limit = 300 }: { after?: number; limit?: number } = {},
): Promise<{ updated: number; more: boolean; next: number }> {
  const pending = await db
    .select({ id: jobs.id, company: jobs.company, title: jobs.title, jdHash: jobs.jdHash })
    .from(jobs)
    .where(and(gt(jobs.id, after), isNull(jobs.dedupeKey)))
    .orderBy(jobs.id)
    .limit(limit + 1);
  const page = pending.slice(0, limit);
  const statements = [];
  for (const row of page) {
    const dedupeKey = await keyOf(row);
    statements.push(db.update(jobs).set({ dedupeKey }).where(eq(jobs.id, row.id)));
  }
  for (const part of chunks(statements, BATCH_STATEMENTS)) await batch(db, part);
  return {
    updated: page.length,
    more: pending.length > limit,
    next: page.at(-1)?.id ?? after,
  };
}

/** A rebuild regroups every key touched within this window (also the look-back before the first cursor). */
const DEDUPE_WINDOW = 3 * 60 * 60;
/**
 * Overlap between incremental passes. Each pass must reach back past the previous pass's end by more than the
 * time a write takes between stamping and committing, and the time a pass takes to run. Thirty minutes is far
 * more than either (a request is seconds; a pass is seconds), and each row is then read by about 1.5 passes
 * instead of the 3 that a 3-hour window over an hourly cron read.
 */
const REGROUP_MARGIN = 30 * 60;
/** Keys per select: each key is 64 characters, so the ids travel as one bound JSON value. */
const KEY_CHUNK = 300;
/**
 * Statements per batch. D1 documents no batch-size cap (its limits are per statement), so this is
 * a budget choice: each batch stays one short transaction well inside the 30 s query limit.
 */
const BATCH_STATEMENTS = 50;

/**
 * Keys of open rows whose source went stale in [since, now): last_listed_at in
 * [since - STALE_HIDE_DAYS, staleBefore), where staleBefore = now - STALE_HIDE_DAYS.
 * The crossed source ids come from `sources` (a small table); their rows are read by source_id
 * through jobs_source_posting_idx, so the reads scale with the sources that changed, not with `jobs`.
 */
export function crossedKeys(db: Db, since: number, staleBefore: number) {
  return db
    .selectDistinct({ key: jobs.dedupeKey })
    .from(jobs)
    .where(
      and(
        isNull(jobs.closedAt),
        isNotNull(jobs.dedupeKey),
        inArray(
          jobs.sourceId,
          db
            .select({ id: sources.id })
            .from(sources)
            .where(
              and(
                gte(sources.lastListedAt, since - STALE_HIDE_DAYS * 86400),
                lt(sources.lastListedAt, staleBefore),
              ),
            ),
        ),
      ),
    );
}

/**
 * Keys whose group may have changed, after the cursor, ascending. Incremental mode finds, each via
 * an index or a small table, never a scan of `jobs`. `since` is the start of the window (see `regroupSince`):
 * - rows written since then (applyJobs, finalize closure and reopen): jobs_updated_idx;
 * - sources that crossed the stale threshold since then (a time change with no write): the few
 *   crossed source ids (a scan of `sources`, a small table), then their keys by jobs_source_posting_idx;
 * - open duplicates whose canonical was written since then: it may have moved key or closed,
 *   so the duplicate's own key is regrouped. A purged canonical cannot exist here: its
 *   group was handed over when it closed, 30 days before the purge.
 * Full mode pages over every open key.
 */
async function keysPage(
  db: Db,
  {
    now,
    full,
    since,
    after,
    limit,
  }: { now: number; full: boolean; since: number; after: string; limit: number },
): Promise<string[]> {
  if (full) {
    const rows = await db
      .selectDistinct({ key: jobs.dedupeKey })
      .from(jobs)
      .where(and(isNull(jobs.closedAt), isNotNull(jobs.dedupeKey), gt(jobs.dedupeKey, after)))
      .orderBy(jobs.dedupeKey)
      .limit(limit);
    return rows.flatMap((r) => (r.key === null ? [] : [r.key]));
  }
  const staleBefore = now - STALE_HIDE_DAYS * 86400;
  const canonicals = alias(jobs, "canonicals");
  const found = await Promise.all([
    db
      .selectDistinct({ key: jobs.dedupeKey })
      .from(jobs)
      .where(and(isNotNull(jobs.dedupeKey), gte(jobs.updatedAt, since))),
    crossedKeys(db, since, staleBefore),
    // Canonicals written in the window (the subquery, by index), then their open duplicates.
    db
      .selectDistinct({ key: jobs.dedupeKey })
      .from(jobs)
      .where(
        and(
          isNotNull(jobs.dupOf),
          isNull(jobs.closedAt),
          isNotNull(jobs.dedupeKey),
          inArray(
            jobs.dupOf,
            db
              .select({ id: canonicals.id })
              .from(canonicals)
              .where(gte(canonicals.updatedAt, since)),
          ),
        ),
      ),
  ]);
  const keys = new Set(found.flat().flatMap((r) => (r.key === null ? [] : [r.key])));
  return [...keys]
    .filter((key) => key > after)
    .sort()
    .slice(0, limit);
}

/**
 * Recomputes `dup_of` for the given keys. A group is the open rows sharing a key and source freshness
 * (so a stale source's row never hides a fresh one); its canonical is the lowest id.
 * Writes only rows whose `dup_of` changes, as json_each id lists in batches of statements.
 */
async function regroup(db: Db, keys: string[], staleBefore: number): Promise<number> {
  let changed = 0;
  for (const part of chunks(keys, KEY_CHUNK)) {
    const rows = await db
      .select({
        id: jobs.id,
        key: jobs.dedupeKey,
        dupOf: jobs.dupOf,
        stale: sql<number>`coalesce(${sources.lastListedAt}, 0) < ${staleBefore}`,
      })
      .from(jobs)
      .leftJoin(sources, eq(sources.id, jobs.sourceId))
      .where(and(isNull(jobs.closedAt), sql`${jobs.dedupeKey} IN ${jsonIds(part)}`))
      .orderBy(jobs.id);

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const groupKey = `${row.key}|${row.stale}`;
      const members = groups.get(groupKey) ?? [];
      members.push(row);
      groups.set(groupKey, members);
    }

    const statements: BatchItem<"sqlite">[] = [];
    const unlink: number[] = [];
    for (const members of groups.values()) {
      const [canonical, ...others] = members;
      if (!canonical) continue;
      if (canonical.dupOf !== null) unlink.push(canonical.id);
      const attach = others.filter((m) => m.dupOf !== canonical.id).map((m) => m.id);
      if (attach.length > 0) {
        changed += attach.length;
        statements.push(
          db
            .update(jobs)
            .set({ dupOf: canonical.id })
            .where(sql`${jobs.id} IN ${jsonIds(attach)}`),
        );
      }
    }
    for (const ids of chunks(unlink, CHUNK)) {
      statements.push(
        db
          .update(jobs)
          .set({ dupOf: null })
          .where(sql`${jobs.id} IN ${jsonIds(ids)}`),
      );
    }
    changed += unlink.length;
    for (const page of chunks(statements, BATCH_STATEMENTS)) await batch(db, page);
  }
  return changed;
}

/**
 * Regroups duplicates: the hourly cron runs it incrementally; `full` walks every key. Keys are
 * processed `limit` at a time, so call again with `after = next` until `next` is null.
 * A canonical that closes in a sync hands over at that run's finalize; changes that never finalize
 * (stale sources, a run that never finished) wait for the hourly pass.
 * The last page records `regroup_state`, so the next incremental pass starts there (see `regroupSince`).
 */
export async function rebuildDuplicates(
  db: Db,
  now = nowSeconds(),
  opts: { full?: boolean; after?: string; limit?: number } = {},
): Promise<{ keys: number; changed: number; next: string | null }> {
  const limit = opts.limit ?? 3000;
  const full = opts.full ?? false;
  // Read once per call; the cursor moves only on the last page, so every page of one pass sees the same window.
  const since = full ? now - DEDUPE_WINDOW : await regroupSince(db, now);
  const keys = await keysPage(db, { now, full, since, after: opts.after ?? "", limit });
  const changed = await regroup(db, keys, now - STALE_HIDE_DAYS * 86400);
  const next = keys.length === limit ? (keys.at(-1) ?? null) : null;
  if (next === null) {
    await db
      .insert(regroupState)
      .values({ id: 1, checkedAt: now })
      .onConflictDoUpdate({ target: regroupState.id, set: { checkedAt: now } });
  }
  return { keys: keys.length, changed, next };
}

/**
 * Where an incremental pass starts: the last complete pass, less REGROUP_MARGIN. The margin covers a write
 * stamped with an earlier `now` than the one it commits under, and a pass that overlaps a sync. A first
 * pass (no cursor yet) looks back DEDUPE_WINDOW.
 */
async function regroupSince(db: Db, now: number): Promise<number> {
  const [row] = await db
    .select({ checkedAt: regroupState.checkedAt })
    .from(regroupState)
    .where(eq(regroupState.id, 1))
    .limit(1);
  return row ? row.checkedAt - REGROUP_MARGIN : now - DEDUPE_WINDOW;
}
