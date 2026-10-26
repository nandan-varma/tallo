import type { CreateRun, Finalize, FinalizeResult, JobFacts } from "@tallo/contracts";
import { CLOSE_AFTER_ABSENT_RUNS, DEAD_AFTER_NOT_FOUND_RUNS, outOfScope } from "@tallo/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { BlobStore } from "./blobs.ts";
import { jdKey, rawKey } from "./blobs.ts";
import type { Db } from "./db.ts";
import { batch, CHUNK, chunks } from "./db.ts";
import { FACET_LIMIT, visibleJobs } from "./queries.ts";
import { facetCounts, jobs, runs, sources } from "./schema.ts";

export class IngestError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

const RUN_LEASE_SECONDS = 2 * 60 * 60;
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

/** Upsert a batch of jobs. Postings whose JD blob is not stored yet are skipped and reported. */
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

  const hashes = [...new Set(incoming.map((j) => j.jdHash))];
  const present = new Set(
    (await Promise.all(hashes.map(async (h) => ((await blobs.has(jdKey(h))) ? h : null)))).filter(
      (h): h is string => !!h,
    ),
  );
  const ready = incoming.filter((j) => present.has(j.jdHash));
  const missingBlobs = hashes.filter((h) => !present.has(h));
  if (ready.length === 0) return { applied: 0, missingBlobs };

  const existing = new Set(
    (
      await db
        .select({ id: jobs.postingId })
        .from(jobs)
        .where(
          and(
            eq(jobs.sourceId, sourceId),
            sql`${jobs.postingId} IN ${jsonIds(ready.map((j) => j.postingId))}`,
          ),
        )
    ).map((r) => r.id),
  );
  const added = ready.filter((j) => !existing.has(j.postingId)).length;

  const upserts = ready.map((j) => {
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
      hidden: outOfScope(j),
    };
    const { firstSeenAt: _keep, ...update } = values;
    return db
      .insert(jobs)
      .values(values)
      .onConflictDoUpdate({
        target: [jobs.sourceId, jobs.postingId],
        set: {
          ...update,
          sortAt: sql`coalesce(${j.postedAt}, ${jobs.firstSeenAt})`,
          absentRuns: 0,
          closedAt: null,
        },
      });
  });
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
    const gone = open.filter((j) => !seen.has(j.postingId) && j.closedAt === null);
    reopened = back.filter((j) => j.closedAt !== null).length;
    closed = gone.filter((j) => j.absentRuns + 1 >= CLOSE_AFTER_ABSENT_RUNS).length;
    for (const ids of chunks(
      back.map((j) => j.id),
      CHUNK,
    )) {
      statements.push(
        db
          .update(jobs)
          .set({ absentRuns: 0, closedAt: null })
          .where(sql`${jobs.id} IN ${jsonIds(ids)}`),
      );
    }
    for (const ids of chunks(
      gone.map((j) => j.id),
      CHUNK,
    )) {
      statements.push(
        db
          .update(jobs)
          .set({
            absentRuns: sql`${jobs.absentRuns} + 1`,
            closedAt: sql`CASE WHEN ${jobs.absentRuns} + 1 >= ${CLOSE_AFTER_ABSENT_RUNS} THEN ${now} END`,
          })
          .where(sql`${jobs.id} IN ${jsonIds(ids)}`),
      );
    }
  }
  const status = fin.listingComplete ? "complete" : "partial";
  // Board health. A complete listing revives a dead board; a 404 counts toward dead; any other
  // outcome breaks the streak, so only consecutive 404s can mark a board dead.
  const health = fin.listingComplete
    ? { consecutiveFailures: 0, status: "active" as const, lastCompleteRunAt: now }
    : fin.boardNotFound
      ? {
          consecutiveFailures: sql`${sources.consecutiveFailures} + 1`,
          status: sql`CASE WHEN ${sources.consecutiveFailures} + 1 >= ${DEAD_AFTER_NOT_FOUND_RUNS} THEN 'dead' ELSE ${sources.status} END`,
        }
      : { consecutiveFailures: 0 };
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
      .set({ lastStatus: status, ...health })
      .where(eq(sources.id, current.sourceId)),
  );
  await batch(db, statements);
  return { status, closureApplied, closed, reopened };
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
  for (const hash of new Set(stale.map((j) => j.jdHash))) {
    const used = (
      await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.jdHash, hash)).limit(1)
    )[0];
    if (!used) await blobs.delete(jdKey(hash));
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
  const retained = sql`(
    SELECT id FROM (
      SELECT id, row_number() OVER (
        PARTITION BY source_id ORDER BY started_at DESC, id DESC
      ) AS rank
      FROM runs WHERE raw_key IS NOT NULL AND raw_uploaded = 1 AND status != 'running'
    ) WHERE rank <= 2
  )`;
  const obsolete = await db
    .select({ id: runs.id, rawKey: runs.rawKey })
    .from(runs)
    .where(sql`${runs.rawKey} IS NOT NULL AND (
      (${runs.status} != 'running' AND ${runs.rawUploaded} = 1 AND ${runs.id} NOT IN ${retained})
      OR ((${runs.status} = 'running' OR ${runs.rawUploaded} = 0) AND ${runs.startedAt} < ${now - 30 * 86400})
    )`)
    .limit(1000);
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
    .where(sql`${runs.startedAt} < ${now - 30 * 86400} AND ${runs.rawKey} IS NULL`)
    .limit(1000);
  for (const ids of chunks(
    expired.map((row) => row.id),
    CHUNK,
  )) {
    await db.delete(runs).where(sql`${runs.id} IN ${jsonIds(ids)}`);
  }
  return { packs: obsolete.length, runs: expired.length };
}

export type Classifier = (row: {
  title: string;
  department: string | null;
  team: string | null;
  locations: unknown;
}) => {
  isUs: 0 | 1 | null;
  isTech: 0 | 1 | null;
  version: number;
};

/**
 * Re-derive heuristic flags for jobs classified by an older rule version, from stored facts alone
 * (no refetching). Call repeatedly until `more` is false.
 */
export async function reclassify(
  db: Db,
  classify: Classifier,
  version: number,
  limit = 300,
): Promise<{ updated: number; more: boolean }> {
  const stale = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      department: jobs.department,
      team: jobs.team,
      facts: jobs.facts,
    })
    .from(jobs)
    .where(sql`${jobs.classifierVersion} < ${version}`)
    .limit(limit + 1);
  const page = stale.slice(0, limit);
  if (page.length > 0) {
    await batch(
      db,
      page.map((row) => {
        const verdict = classify({ ...row, locations: row.facts.locations });
        return db
          .update(jobs)
          .set({
            isUs: verdict.isUs,
            isTech: verdict.isTech,
            classifierVersion: verdict.version,
            hidden: outOfScope(verdict),
          })
          .where(eq(jobs.id, row.id));
      }),
    );
  }
  return { updated: page.length, more: stale.length > limit };
}

const FACET_KEYS = ["workMode", "department", "employmentType", "country"] as const;

/**
 * Recounts facets over the default-visible catalog and replaces the snapshot in one batch, so
 * readers see either the old or the new counts. Reads: one scan of visible jobs (grouped in
 * SQL, aggregated here) plus one `sources` lookup per visible job for the staleness check.
 * Run hourly by the cron; the snapshot is at most that old.
 */
export async function rebuildFacets(
  db: Db,
  now = nowSeconds(),
  limit = FACET_LIMIT,
): Promise<{ values: number }> {
  const groups = await db
    .select({
      workMode: jobs.workMode,
      department: jobs.department,
      employmentType: jobs.employmentType,
      country: jobs.countryCode,
      count: sql<number>`count(*)`,
    })
    .from(jobs)
    .where(and(...visibleJobs(now)))
    .groupBy(jobs.workMode, jobs.department, jobs.employmentType, jobs.countryCode);

  // Each job falls in exactly one group, so summing groups per value gives the facet count.
  const rows: { facet: string; value: string; count: number }[] = [];
  for (const facet of FACET_KEYS) {
    const totals = new Map<string, number>();
    for (const group of groups) {
      const value = group[facet];
      if (value !== null) totals.set(value, (totals.get(value) ?? 0) + group.count);
    }
    const top = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
    for (const [value, count] of top) rows.push({ facet, value, count });
  }

  // One bound parameter carries every row (json_each), so the size never hits the bind limit.
  await batch(db, [
    db.delete(facetCounts),
    db.run(
      sql`INSERT INTO facet_counts (facet, value, count, computed_at) SELECT json_extract(j.value, '$.facet'), json_extract(j.value, '$.value'), json_extract(j.value, '$.count'), ${now} FROM json_each(${JSON.stringify(rows)}) AS j`,
    ),
  ]);
  return { values: rows.length };
}
