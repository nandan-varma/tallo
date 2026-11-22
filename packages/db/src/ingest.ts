import { boundFacts, slug } from "@tallo/catalog";
import type {
  ApplyResult,
  CreateRun,
  Finalize,
  FinalizeInput,
  FinalizeResult,
  JobFacts,
  RetireResult,
  StartedRun,
} from "@tallo/contracts";
import {
  CLOSE_AFTER_ABSENT_RUNS,
  DEAD_AFTER_NOT_FOUND_RUNS,
  nextDueAt,
  RETIRE_MAX_ROWS,
  RETIRE_MAX_SOURCES,
  type RunOutcome,
  STALE_HIDE_DAYS,
  titleTokens as tokenizeTitle,
} from "@tallo/contracts";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { BlobStore } from "./blobs.ts";
import { jdKey, rawKey } from "./blobs.ts";
import type { Db } from "./db.ts";
import { batch, CHUNK, chunks, jsonIds, nowSeconds } from "./db.ts";
import { regroup, regroupSource } from "./dedupe.ts";
import { IngestError } from "./ingest-error.ts";
import { companies, jobs, runs, sources, titleTokens } from "./schema.ts";

const RUN_LEASE_SECONDS = 2 * 60 * 60;
/** Description hashes checked per purge lookup (one statement each). */
const HASH_CHUNK = 100;
/** Hashes per retirement reference lookup: larger is fewer D1 round trips, still a small SQL text. */
const RETIRE_HASH_CHUNK = 500;

/**
 * Admin: put boards back in the schedule after a wrong verdict (a board marked dead that answers now,
 * or one whose 404s came from a block). Clears the dead status, the 404 streak and the failure back-off,
 * and makes each board due now. Only board health and the due time change: no run, posting or closure does.
 * Returns the ids that exist.
 */
export async function reviveSources(db: Db, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(sources)
    .set({ status: "active", consecutiveFailures: 0, failureCount: 0, nextDueAt: 0 })
    .where(sql`${sources.id} IN ${jsonIds(ids)}`)
    .returning({ id: sources.id });
  return rows.map((r) => r.id);
}

async function run(db: Db, runId: string) {
  const row = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0];
  if (!row) throw new IngestError(404, `Unknown run ${runId}`);
  return row;
}

/** Idempotent on runId. One running run per source at a time (a stale one is superseded). */
export async function startRun(db: Db, input: CreateRun, now = nowSeconds()): Promise<StartedRun> {
  const stored = async () =>
    (
      await db
        .select({ validator: sources.listingValidator })
        .from(sources)
        .where(eq(sources.id, input.source.id))
        .limit(1)
    )[0]?.validator ?? null;
  const existing = (await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1))[0];
  if (existing) return { validator: await stored() };
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
  const validator = await stored();
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
  return { validator };
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

/**
 * `diff` and, when no posting changed, `finalize` in the same call (one round trip for an unchanged
 * board). The finalize is the ordinary one, idempotent on runId; a changed board only gets its diff.
 */
export async function diffOrFinish(
  db: Db,
  runId: string,
  postings: { id: string; hash: string }[],
  finish: Omit<FinalizeInput, "seenIds" | "rawKey">,
  now = nowSeconds(),
): Promise<{ changed: string[]; finalized?: FinalizeResult }> {
  const changed = await diff(db, runId, postings);
  if (changed.length > 0) return { changed };
  const finalized = await finalize(
    db,
    runId,
    { ...finish, seenIds: postings.map((p) => p.id), rawKey: null },
    now,
  );
  return { changed, finalized };
}

export type { ApplyResult } from "@tallo/contracts";

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
  received: JobFacts[],
  now = nowSeconds(),
): Promise<ApplyResult> {
  const { sourceId } = await run(db, runId);
  const source = (await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1))[0];
  if (!source) throw new IngestError(404, `Unknown source ${sourceId}`);

  // The Worker path reaches here without the wire schema: fit each posting instead of failing the batch.
  const incoming: JobFacts[] = [];
  const invalid: ApplyResult["invalid"] = [];
  const bounded: ApplyResult["bounded"] = [];
  for (const job of received) {
    try {
      const fit = boundFacts(job);
      incoming.push(fit.facts);
      if (fit.notes.length) bounded.push({ postingId: job.postingId, notes: fit.notes });
    } catch (error) {
      invalid.push({
        postingId: String(job.postingId).slice(0, 100),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
  if (ready.length === 0) return { applied: 0, missingBlobs, invalid, bounded };

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
    .set({
      lastListedAt: sql`coalesce(${sources.lastListedAt}, ${now})`,
      // Jobs changed, so the stored listing no longer describes the catalog until a run finishes cleanly.
      listingValidator: null,
    })
    .where(eq(sources.id, sourceId));
  // Discovery vocabulary: one row per seen company, one per observed title word. Both are tiny and read-only for
  // the public `/v1/companies` and `/v1/titles` endpoints. Only a batch that actually changes a job touches them,
  // so re-applying an identical listing still writes nothing but the run's counters; the company update is a
  // no-op when the stored name is unchanged, and existing title words conflict without a write.
  const discovery: BatchItem<"sqlite">[] = [];
  if (upserts.length > 0) {
    discovery.push(
      db
        .insert(companies)
        .values({ slug: source.companySlug, name: source.company, updatedAt: now })
        .onConflictDoUpdate({
          target: companies.slug,
          set: { name: source.company, updatedAt: now },
          setWhere: sql`${companies.name} != ${source.company}`,
        }),
    );
    const words = [...new Set(ready.flatMap((j) => tokenizeTitle(j.title)))].slice(0, 2000);
    for (const part of chunks(words, 40))
      discovery.push(
        db
          .insert(titleTokens)
          .values(part.map((token) => ({ token })))
          .onConflictDoNothing(),
      );
  }
  await batch(db, [...upserts, ...discovery, counters, listed]);

  // `purgeClosed` can delete a blob between the existence check above and the batch above. Re-check the
  // blobs of rows this call wrote that purge could have been racing: new rows, reopened (closed) rows and
  // rows pointing at a new description. A row whose blob vanished gets a source hash no listing can match,
  // so the next diff re-sends it and the runner re-uploads the description; the hash is also reported now.
  const risky = [
    ...new Set(
      ready
        .filter((j) => {
          const prior = stored.get(j.postingId);
          return !prior || prior.closedAt !== null || prior.jdHash !== j.jdHash;
        })
        .map((j) => j.jdHash),
    ),
  ];
  const lost = (
    await Promise.all(risky.map(async (h) => ((await blobs.has(jdKey(h))) ? null : h)))
  ).filter((h): h is string => h !== null);
  if (lost.length > 0) {
    for (const part of chunks(lost, HASH_CHUNK))
      await db
        .update(jobs)
        .set({ sourceHash: "" })
        .where(and(eq(jobs.sourceId, sourceId), sql`${jobs.jdHash} IN ${jsonIds(part)}`));
    missingBlobs.push(...lost);
  }
  return { applied: ready.length, missingBlobs, invalid, bounded };
}

/**
 * Closes the run. Only a complete, non-empty (or authoritatively empty) listing may age out
 * jobs: a failed or partial run never proves anything disappeared.
 */
export async function finalize(
  db: Db,
  runId: string,
  claimed: FinalizeInput,
  now = nowSeconds(),
): Promise<FinalizeResult> {
  let fin: Finalize = { boardNotFound: false, notModified: false, ...claimed };
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
      failureCount: sources.failureCount,
      listingValidator: sources.listingValidator,
    })
    .from(sources)
    .where(eq(sources.id, current.sourceId))
    .limit(1);
  // A 304 vouches for the stored listing only. Without a matching stored validator it proves nothing:
  // the run becomes a failed one (never complete, never closing).
  if (fin.notModified && (!before?.listingValidator || before.listingValidator !== fin.validator)) {
    fin = {
      ...fin,
      notModified: false,
      listingComplete: false,
      detailsComplete: false,
      seenIds: [],
      validator: null,
      issues: [
        ...fin.issues,
        { code: "http" as const, message: "Listing answered 304 without a stored validator" },
      ].slice(0, 50),
    };
  }
  const wasStale = (before?.lastListedAt ?? 0) < now - STALE_HIDE_DAYS * 86400;
  // A 304 lists nothing, so it can never age out or reopen a job: it only confirms the last listing.
  const closureApplied =
    !fin.notModified && fin.listingComplete && (fin.seenIds.length > 0 || fin.emptyIsAuthoritative);
  // Jobs on their first absence need another full listing to be closed, so the board cannot be skipped yet.
  let pendingAbsence = false;
  let closed = 0;
  let reopened = 0;
  const statements: BatchItem<"sqlite">[] = [];
  // The counters below add 1. A second finalize of the same run that read `running` before the first committed
  // must add nothing, or one absence would count twice and close a posting early. The run's own update comes last.
  const stillRunning = sql`EXISTS (SELECT 1 FROM ${runs} WHERE ${runs.id} = ${runId} AND ${runs.status} = 'running')`;

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
    pendingAbsence = absent.length > 0;
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
          .where(and(sql`${jobs.id} IN ${jsonIds(ids)}`, stillRunning)),
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
          .where(and(sql`${jobs.id} IN ${jsonIds(ids)}`, stillRunning)),
      );
    }
  }
  // A complete listing with no postings that the platform does not vouch for (and that is not a 304) proves
  // neither that the board is alive nor that it is empty: a retired board can answer exactly that way. It
  // is treated as a failed run for health, freshness and back-off, and it still closes nothing.
  const unproven =
    fin.listingComplete &&
    !fin.notModified &&
    fin.seenIds.length === 0 &&
    !fin.emptyIsAuthoritative;
  const listingOk = fin.listingComplete && !unproven;
  const status = listingOk ? "complete" : "partial";
  // A listing that returned (proven complete, or any postings seen) counts for freshness; a failed one does not.
  const listed = listingOk || fin.seenIds.length > 0;
  // Board health. Only a successful listing resets the not-found streak and revives a dead board.
  // A board-not-found run adds to the streak. Any other failure says nothing about whether the
  // board exists, so it leaves the streak as it is: a timeout between two 404s must not hide them.
  // `consecutive_failures` holds that streak.
  const health = listingOk
    ? { consecutiveFailures: 0, status: "active" as const, lastCompleteRunAt: now }
    : fin.boardNotFound
      ? {
          consecutiveFailures: sql`${sources.consecutiveFailures} + 1`,
          status: sql`CASE WHEN ${sources.consecutiveFailures} + 1 >= ${DEAD_AFTER_NOT_FOUND_RUNS} THEN 'dead' ELSE ${sources.status} END`,
        }
      : {};
  statements.push(
    db
      .update(sources)
      .set({
        lastStatus: status,
        ...health,
        // Any run that did not list completely is a failed run; a complete one resets the back-off.
        failureCount: listingOk ? 0 : sql`${sources.failureCount} + 1`,
        // Kept only by a listing that was complete and fully applied; a 304 re-confirms the stored one.
        ...(fin.notModified
          ? {}
          : {
              listingValidator:
                closureApplied && fin.detailsComplete && !pendingAbsence
                  ? (fin.validator ?? null)
                  : null,
            }),
        ...(listed ? { lastListedAt: now } : {}),
        nextDueAt: nextDueAt({
          tier: before?.tier ?? "normal",
          outcome: runOutcome({ ...fin, listingComplete: listingOk }, before),
          finishedAt: fin.finishedAt,
          failures: listingOk ? 0 : (before?.failureCount ?? 0) + 1,
          neverListed: before?.lastListedAt == null,
        }),
      })
      .where(and(eq(sources.id, current.sourceId), stillRunning)),
    db
      .update(runs)
      .set({
        status,
        finishedAt: fin.finishedAt,
        requests: fin.requests,
        seen: fin.notModified ? null : fin.seenIds.length,
        closed: closureApplied ? closed : null,
        reopened: closureApplied ? reopened : null,
        rawKey: current.rawKey ?? fin.rawKey,
        issues: fin.issues,
      })
      .where(eq(runs.id, runId)),
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
 * Runs still `running` past the lease. A literal status, not a bound one, so SQLite can use `runs_running_idx`.
 * `sources` limits it to those boards, and `leaseSeconds` replaces the lease: the operator's way to release a board
 * whose collector process was stopped, instead of waiting out the lease.
 */
export function staleRunsQuery(
  db: Db,
  now: number,
  {
    sources: boards,
    leaseSeconds = RUN_LEASE_SECONDS,
  }: { sources?: string[]; leaseSeconds?: number } = {},
) {
  return db
    .select({ id: runs.id, sourceId: runs.sourceId, startedAt: runs.startedAt })
    .from(runs)
    .where(
      and(
        sql`${runs.status} = 'running'`,
        lt(runs.startedAt, now - leaseSeconds),
        boards ? sql`${runs.sourceId} IN ${jsonIds(boards)}` : undefined,
      ),
    )
    .limit(1000);
}

/**
 * Marks runs still `running` past the lease as partial: the collector died before it could finalize.
 * It closes nothing (a partial run never proves a posting is gone). The run counts as a failed run
 * for its board: `failure_count` grows and `next_due_at` follows the back-off, so a board whose
 * collector keeps dying is not re-claimed every lease. Only the board's latest run updates its
 * health (an older run reaped after a newer one finished must not undo it). A board already dead
 * keeps its dead interval. The 404 streak and status are left alone (a dead collector says nothing
 * about whether the board exists). A late finalize from the dead
 * collector is then a no-op, because the run is no longer running.
 */
export async function reapStaleRuns(
  db: Db,
  now = nowSeconds(),
  options: { sources?: string[]; leaseSeconds?: number } = {},
): Promise<number> {
  const stale = await staleRunsQuery(db, now, options);
  const byBoard = new Map<string, { ids: string[]; newest: number }>();
  for (const r of stale) {
    const group = byBoard.get(r.sourceId) ?? { ids: [], newest: 0 };
    group.ids.push(r.id);
    group.newest = Math.max(group.newest, r.startedAt);
    byBoard.set(r.sourceId, group);
  }
  let reaped = 0;
  for (const boards of chunks([...byBoard.keys()], 50)) {
    // Boards with a newer run than any run reaped here keep the health that run wrote.
    const latest = await db
      .select({ sourceId: runs.sourceId, startedAt: sql<number>`max(${runs.startedAt})` })
      .from(runs)
      .where(sql`${runs.sourceId} IN ${jsonIds(boards)}`)
      .groupBy(runs.sourceId);
    const current = new Set(
      latest
        .filter((l) => l.startedAt <= (byBoard.get(l.sourceId)?.newest ?? 0))
        .map((l) => l.sourceId),
    );
    const health = new Map(
      (
        await db
          .select({
            id: sources.id,
            tier: sources.tier,
            failureCount: sources.failureCount,
            lastListedAt: sources.lastListedAt,
            status: sources.status,
            consecutiveFailures: sources.consecutiveFailures,
          })
          .from(sources)
          .where(sql`${sources.id} IN ${jsonIds(boards)}`)
      ).map((b) => [b.id, b]),
    );
    // Per board, the run flip and the health write are one batch, so a crash cannot leave a reaped run
    // without its failure. Both carry the same guard: every run read as stale is still running. A finalize
    // that lands in between makes the guard false for that board; nothing is written for it and the runs
    // still running are picked up by the next pass. The guard is what keeps a failure from being counted
    // for a run this reap did not flip.
    const statements: BatchItem<"sqlite">[] = [];
    const flips: number[] = [];
    for (const sourceId of boards) {
      const { ids } = byBoard.get(sourceId)!;
      const untouched = sql`(SELECT count(*) FROM ${runs} WHERE ${runs.sourceId} = ${sourceId} AND ${runs.status} = 'running' AND ${runs.id} IN ${jsonIds(ids)}) = ${ids.length}`;
      const b = health.get(sourceId);
      if (b && current.has(sourceId)) {
        const failures = b.failureCount + ids.length;
        statements.push(
          db
            .update(sources)
            .set({
              lastStatus: "partial",
              failureCount: failures,
              nextDueAt: nextDueAt({
                tier: b.tier,
                outcome: runOutcome({ listingComplete: false, boardNotFound: false }, b),
                finishedAt: now,
                failures,
                neverListed: b.lastListedAt == null,
              }),
            })
            .where(and(eq(sources.id, sourceId), untouched)),
        );
      }
      statements.push(
        db
          .update(runs)
          .set({
            status: "partial",
            finishedAt: now,
            issues: [{ code: "stopped", message: "Collector process stopped before finalize" }],
          })
          .where(and(eq(runs.status, "running"), sql`${runs.id} IN ${jsonIds(ids)}`, untouched))
          .returning({ id: runs.id }),
      );
      flips.push(statements.length - 1);
    }
    const results = (await batch(db, statements)) as { id: string }[][];
    for (const i of flips) reaped += results[i]?.length ?? 0;
  }
  return reaped;
}

/** Delete jobs closed for over `days`, then any JD blob no remaining job references. */
export async function purgeClosed(
  db: Db,
  blobs: BlobStore,
  days = 30,
  now = nowSeconds(),
  limit = 1000,
): Promise<number> {
  const stale = await db
    .select({ id: jobs.id, jdHash: jobs.jdHash })
    .from(jobs)
    .where(sql`${jobs.closedAt} IS NOT NULL AND ${jobs.closedAt} < ${now - days * 86400}`)
    .limit(limit);
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
    for (const hash of part) {
      if (used.has(hash)) continue;
      // An `applyJobs` may have checked this blob and be about to write a row that references it. Keep the
      // bytes, delete, and look again: a reference that appeared meanwhile gets the blob put back.
      const bytes = await blobs.get(jdKey(hash));
      if (!bytes) continue;
      await blobs.delete(jdKey(hash));
      const [again] = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.jdHash, hash))
        .limit(1);
      if (again) await blobs.put(jdKey(hash), bytes);
    }
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
 * Explicit operator retirement, after removing reviewed boards from sources/. Historical runs and
 * all R2 objects remain for audit. Returned orphan hashes are cleanup candidates, not deletion
 * permission: another board can acquire a reference after this call.
 */
export async function retireSources(
  db: Db,
  requested: string[],
  { dryRun = false, now = nowSeconds() }: { dryRun?: boolean; now?: number } = {},
): Promise<RetireResult> {
  const ids = [...new Set(requested)];
  if (ids.length > RETIRE_MAX_SOURCES)
    throw new IngestError(409, `Retire at most ${RETIRE_MAX_SOURCES} reviewed sources per request`);
  const resultWith = (
    sourceIds: string[],
    jobCount: number,
    rawKeys: string[],
    orphanJdHashes: string[],
  ): RetireResult => ({ sources: sourceIds, jobs: jobCount, rawKeys, orphanJdHashes, dryRun });
  if (ids.length === 0) return resultWith([], 0, [], []);
  const selected = await db
    .select({ id: sources.id })
    .from(sources)
    .where(sql`${sources.id} IN ${jsonIds(ids)}`);
  const sourceIds = selected.map((s) => s.id).sort();
  // Unknown and already-retired ids are idempotent; only boards still in the catalog are acted on.
  if (sourceIds.length === 0) return resultWith([], 0, [], []);
  const running = await db
    .select({ id: runs.id, sourceId: runs.sourceId })
    .from(runs)
    .where(and(sql`${runs.sourceId} IN ${jsonIds(sourceIds)}`, eq(runs.status, "running")))
    .limit(1);
  if (running[0])
    throw new IngestError(
      409,
      `Source ${running[0].sourceId} has a running run (${running[0].id})`,
    );
  const history = await db
    .select({ sourceId: runs.sourceId, id: runs.id, rawKey: runs.rawKey })
    .from(runs)
    .where(sql`${runs.sourceId} IN ${jsonIds(sourceIds)}`)
    .orderBy(runs.startedAt, runs.id)
    .limit(RETIRE_MAX_ROWS + 1);
  const removed = await db
    .select({ id: jobs.id, hash: jobs.jdHash, key: jobs.dedupeKey })
    .from(jobs)
    .where(sql`${jobs.sourceId} IN ${jsonIds(sourceIds)}`)
    .orderBy(jobs.id)
    .limit(RETIRE_MAX_ROWS + 1);
  if (removed.length > RETIRE_MAX_ROWS || history.length > RETIRE_MAX_ROWS)
    throw new IngestError(
      409,
      `Retirement exceeds ${RETIRE_MAX_ROWS} jobs or historical runs; use a smaller source batch`,
    );
  const hashes = [...new Set(removed.map((j) => j.hash))];
  const referenced = new Set<string>();
  for (const part of chunks(hashes, RETIRE_HASH_CHUNK)) {
    const kept = await db
      .selectDistinct({ hash: jobs.jdHash })
      .from(jobs)
      .where(
        and(
          sql`${jobs.jdHash} IN ${jsonIds(part)}`,
          sql`${jobs.sourceId} NOT IN ${jsonIds(sourceIds)}`,
        ),
      );
    for (const row of kept) referenced.add(row.hash);
  }
  const result = resultWith(
    sourceIds,
    removed.length,
    // Only this source's own pack path: a foreign or hand-written key is not source-owned.
    [
      ...new Set(
        history.flatMap((r) =>
          r.rawKey !== null && r.rawKey === rawKey(r.sourceId, r.id) ? [r.rawKey] : [],
        ),
      ),
    ],
    hashes.filter((h) => !referenced.has(h)),
  );
  if (dryRun) return result;
  await batch(db, [
    // Unlink before deleting canonicals so a failed regroup can never hide surviving listings.
    db
      .update(jobs)
      .set({ dupOf: null, updatedAt: now })
      .where(
        and(
          isNotNull(jobs.dupOf),
          sql`${jobs.dupOf} IN ${jsonIds(removed.map((j) => j.id))}`,
          sql`${jobs.sourceId} NOT IN ${jsonIds(sourceIds)}`,
        ),
      ),
    db.delete(jobs).where(sql`${jobs.sourceId} IN ${jsonIds(sourceIds)}`),
    db.delete(sources).where(sql`${sources.id} IN ${jsonIds(sourceIds)}`),
  ]);
  // A surviving duplicate becomes the next canonical; the helper owns that choice and its cursor.
  const keys = [...new Set(removed.flatMap((j) => (j.key === null ? [] : [j.key])))];
  await regroup(db, keys, now - STALE_HIDE_DAYS * 86400);
  return result;
}
