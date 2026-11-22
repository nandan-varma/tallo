import { STALE_HIDE_DAYS } from "@tallo/contracts";
import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { Db } from "./db.ts";
import { batch, CHUNK, chunks, jsonIds, nowSeconds } from "./db.ts";
import { IngestError } from "./ingest-error.ts";
import { jobs, regroupProgress, regroupState, sources } from "./schema.ts";

/**
 * Regroups the keys this source's finalize can change, so its closures, reopens and freshness take
 * effect now instead of at the next hourly pass. Normally that is the keys of the rows
 * written in the window (the run just wrote them). When the source comes back from stale, it is every
 * key the source has. Writes only rows whose `dup_of` changes.
 */
export async function regroupSource(
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

const INCREMENTAL_CURSOR = "i1:";
const incrementalCursorSchema = z
  .object({
    at: z.number().int().nonnegative(),
    since: z.number().int().nonnegative(),
    phase: z.enum(["updated", "duplicates", "stale"]),
    updatedAt: z.number().int().nonnegative(),
    id: z.number().int().nonnegative(),
    duplicateId: z.number().int().nonnegative(),
    source: z.string().max(200),
    posting: z.string().max(512),
  })
  .strict()
  .refine((c) => c.since <= c.updatedAt && c.updatedAt <= c.at);
type IncrementalCursor = z.infer<typeof incrementalCursorSchema>;

function resumeRegroup(after: string, now: number): IncrementalCursor {
  const invalid = () =>
    new IngestError(
      409,
      "Invalid or legacy incremental regroup cursor; restart without after. Full rebuilds still accept key cursors.",
    );
  if (!after.startsWith(INCREMENTAL_CURSOR) || after.length > 8192) throw invalid();
  try {
    const parsed = incrementalCursorSchema.safeParse(
      JSON.parse(after.slice(INCREMENTAL_CURSOR.length)),
    );
    if (!parsed.success || parsed.data.at > now) throw invalid();
    return parsed.data;
  } catch {
    throw invalid();
  }
}

/**
 * One candidate row per (phase, key source). `<phase> > (cursor)` is written as a series of
 * equality/tie seeks plus a newer-range seek rather than a tuple comparison: SQLite can seek those
 * through the existing indexes, while a row-value range is only filtered after reading every
 * equal-timestamp row before the cursor.
 * - updated: updated_at = cursor.updated_at AND id > cursor.id, then updated_at > cursor.updated_at;
 * - duplicates: duplicates of the cursor canonical, then later canonicals at the same updated_at,
 *   then newer canonicals. CROSS JOIN keeps canonicals the outer, ranged loop;
 * - stale: the rest of the cursor source's postings, then later crossed sources. CROSS JOIN keeps
 *   `sources` (a small table) the outer loop so jobs are read through jobs_source_posting_idx.
 * Every segment is ordered and limited before the next one is needed, and the caller asks for one
 * lookahead row. Exposed for the same query-plan checks as `crossedKeys`.
 */
export interface RegroupCandidate {
  key: string | null;
  updatedAt: number;
  id: number;
  duplicateId: number;
  source: string;
  posting: string;
}

export async function regroupCandidates(
  db: Db,
  cursor: IncrementalCursor,
  limit: number,
): Promise<RegroupCandidate[]> {
  const canonicals = alias(jobs, "canonicals");
  if (cursor.phase === "updated") {
    const tie = await db
      .select({
        key: jobs.dedupeKey,
        updatedAt: jobs.updatedAt,
        id: jobs.id,
        duplicateId: sql<number>`0`,
        source: sql<string>`''`,
        posting: sql<string>`''`,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.updatedAt, cursor.updatedAt),
          gt(jobs.id, cursor.id),
          gte(jobs.updatedAt, cursor.since),
          lte(jobs.updatedAt, cursor.at),
          isNotNull(jobs.dedupeKey),
        ),
      )
      .orderBy(jobs.id)
      .limit(limit);
    if (tie.length >= limit) return tie;
    const newer = await db
      .select({
        key: jobs.dedupeKey,
        updatedAt: jobs.updatedAt,
        id: jobs.id,
        duplicateId: sql<number>`0`,
        source: sql<string>`''`,
        posting: sql<string>`''`,
      })
      .from(jobs)
      .where(
        and(
          gt(jobs.updatedAt, cursor.updatedAt),
          gte(jobs.updatedAt, cursor.since),
          lte(jobs.updatedAt, cursor.at),
          isNotNull(jobs.dedupeKey),
        ),
      )
      .orderBy(jobs.updatedAt, jobs.id)
      .limit(limit - tie.length);
    return [...tie, ...newer];
  }
  if (cursor.phase === "duplicates") {
    const duplicates = {
      key: jobs.dedupeKey,
      updatedAt: canonicals.updatedAt,
      id: canonicals.id,
      duplicateId: jobs.id,
      source: sql<string>`''`,
      posting: sql<string>`''`,
    };
    const rows: RegroupCandidate[] = [];
    // The cursor canonical's remaining open duplicates: jobs_dup_of_idx, ordered by duplicate id.
    rows.push(
      ...(await db
        .select(duplicates)
        .from(canonicals)
        .crossJoin(jobs)
        .where(
          and(
            eq(canonicals.updatedAt, cursor.updatedAt),
            eq(canonicals.id, cursor.id),
            gt(jobs.id, cursor.duplicateId),
            eq(jobs.dupOf, canonicals.id),
            isNull(jobs.closedAt),
            isNotNull(jobs.dedupeKey),
          ),
        )
        .orderBy(jobs.id)
        .limit(limit)),
    );
    if (rows.length >= limit) return rows;
    // Later canonical ids in the cursor timestamp: jobs_updated_idx equality, then rowid.
    rows.push(
      ...(await db
        .select(duplicates)
        .from(canonicals)
        .crossJoin(jobs)
        .where(
          and(
            eq(canonicals.updatedAt, cursor.updatedAt),
            gt(canonicals.id, cursor.id),
            eq(jobs.dupOf, canonicals.id),
            isNull(jobs.closedAt),
            isNotNull(jobs.dedupeKey),
          ),
        )
        .orderBy(canonicals.id, jobs.id)
        .limit(limit - rows.length)),
    );
    if (rows.length >= limit) return rows;
    // Newer canonical timestamps: jobs_updated_idx range. Canonicals may have moved or nulled
    // their key; the duplicate's own key is what needs regrouping.
    rows.push(
      ...(await db
        .select(duplicates)
        .from(canonicals)
        .crossJoin(jobs)
        .where(
          and(
            gt(canonicals.updatedAt, cursor.updatedAt),
            gte(canonicals.updatedAt, cursor.since),
            lte(canonicals.updatedAt, cursor.at),
            eq(jobs.dupOf, canonicals.id),
            isNull(jobs.closedAt),
            isNotNull(jobs.dedupeKey),
          ),
        )
        .orderBy(canonicals.updatedAt, canonicals.id, jobs.id)
        .limit(limit - rows.length)),
    );
    return rows;
  }
  const rows: RegroupCandidate[] = [];
  // The rest of the cursor source's open postings: jobs_source_posting_idx equality, then posting id.
  if (cursor.source !== "")
    rows.push(
      ...(await db
        .select({
          key: jobs.dedupeKey,
          updatedAt: sql<number>`${cursor.since}`,
          id: sql<number>`0`,
          duplicateId: sql<number>`0`,
          source: jobs.sourceId,
          posting: jobs.postingId,
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.sourceId, cursor.source),
            gt(jobs.postingId, cursor.posting),
            isNull(jobs.closedAt),
            isNotNull(jobs.dedupeKey),
          ),
        )
        .orderBy(jobs.postingId)
        .limit(limit)),
    );
  if (rows.length >= limit) return rows;
  // Later sources whose last_listed_at crossed the stale threshold during this pass.
  rows.push(
    ...(await db
      .select({
        key: jobs.dedupeKey,
        updatedAt: sql<number>`${cursor.since}`,
        id: sql<number>`0`,
        duplicateId: sql<number>`0`,
        source: sources.id,
        posting: jobs.postingId,
      })
      .from(sources)
      .crossJoin(jobs)
      .where(
        and(
          gt(sources.id, cursor.source),
          gte(sources.lastListedAt, cursor.since - STALE_HIDE_DAYS * 86400),
          lt(sources.lastListedAt, cursor.at - STALE_HIDE_DAYS * 86400),
          eq(jobs.sourceId, sources.id),
          isNull(jobs.closedAt),
          isNotNull(jobs.dedupeKey),
        ),
      )
      .orderBy(sources.id, jobs.postingId)
      .limit(limit - rows.length)),
  );
  return rows;
}

async function incrementalPage(db: Db, cursor: IncrementalCursor, limit: number) {
  const keys = new Set<string>();
  let remaining = limit;
  for (;;) {
    const rows = await regroupCandidates(db, cursor, remaining + 1);
    const page = rows.slice(0, remaining);
    for (const row of page) if (row.key !== null) keys.add(row.key);
    const last = page.at(-1);
    if (last)
      cursor = {
        ...cursor,
        updatedAt: last.updatedAt,
        id: last.id,
        duplicateId: last.duplicateId,
        source: last.source,
        posting: last.posting,
      };
    remaining -= page.length;
    if (rows.length > page.length)
      return { keys: [...keys], next: INCREMENTAL_CURSOR + JSON.stringify(cursor) };
    if (cursor.phase === "stale") return { keys: [...keys], next: null };
    cursor = {
      ...cursor,
      phase: cursor.phase === "updated" ? "duplicates" : "stale",
      updatedAt: cursor.since,
      id: 0,
      duplicateId: 0,
      source: "",
      posting: "",
    };
    if (remaining === 0)
      return { keys: [...keys], next: INCREMENTAL_CURSOR + JSON.stringify(cursor) };
  }
}

/**
 * Recomputes `dup_of` for the given keys. A group is the open rows sharing a key and source freshness
 * (so a stale source's row never hides a fresh one); its canonical is the lowest id.
 * Writes only rows whose `dup_of` changes, as json_each id lists in batches of statements.
 */
export async function regroup(db: Db, keys: string[], staleBefore: number): Promise<number> {
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
 * Regroups duplicates: the hourly cron runs it incrementally; `full` walks every dedupe key.
 * `limit` bounds one page of work, so call again with `after = next` until `next` is null. The
 * incremental page is an opaque candidate cursor; a full page is the last plain dedupe key read.
 * A canonical that closes in a sync hands over at that run's finalize; changes that never finalize
 * (stale sources, a run that never finished) wait for the hourly pass.
 * Every incremental page that leaves work records its cursor in `regroup_progress`; a call without `after` resumes
 * that cursor. The completing page records `regroup_state`, so the next new pass starts there (see `regroupSince`).
 */
export async function rebuildDuplicates(
  db: Db,
  now = nowSeconds(),
  opts: { full?: boolean; after?: string; limit?: number } = {},
): Promise<{ keys: number; changed: number; next: string | null }> {
  const limit = opts.limit ?? 3000;
  const full = opts.full ?? false;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000)
    throw new IngestError(409, "Regroup limit must be an integer from 1 to 5000");
  if (full) {
    if (opts.after?.startsWith(INCREMENTAL_CURSOR))
      throw new IngestError(409, "Incremental regroup cursor cannot resume a full rebuild");
    const rows = await db
      .selectDistinct({ key: jobs.dedupeKey })
      .from(jobs)
      .where(
        and(isNull(jobs.closedAt), isNotNull(jobs.dedupeKey), gt(jobs.dedupeKey, opts.after ?? "")),
      )
      .orderBy(jobs.dedupeKey)
      .limit(limit);
    const keys = rows.flatMap((r) => (r.key === null ? [] : [r.key]));
    const changed = await regroup(db, keys, now - STALE_HIDE_DAYS * 86400);
    // A full key cursor has no frozen start time. It must not advance the incremental checkpoint
    // past writes that arrived behind its key cursor while this potentially long pass was running.
    return {
      keys: keys.length,
      changed,
      next: keys.length === limit ? (keys.at(-1) ?? null) : null,
    };
  }
  // No `after`: resume the unfinished pass recorded by the last call, if any; otherwise start a new one.
  const cursor = opts.after
    ? resumeRegroup(opts.after, now)
    : ((await storedRegroupCursor(db, now)) ?? (await freshRegroupCursor(db, now)));
  const { keys, next } = await incrementalPage(db, cursor, limit);
  const changed = await regroup(db, keys, cursor.at - STALE_HIDE_DAYS * 86400);
  if (next === null) {
    // One batch: the pass is complete, so its checkpoint is recorded and its progress row goes.
    await batch(db, [
      db
        .insert(regroupState)
        .values({ id: 1, checkedAt: cursor.at })
        .onConflictDoUpdate({ target: regroupState.id, set: { checkedAt: cursor.at } }),
      db.delete(regroupProgress).where(eq(regroupProgress.id, 1)),
    ]);
  } else {
    // Persisted on every page that leaves work, so a stopped invocation (budget, timeout, crash) resumes here.
    await db
      .insert(regroupProgress)
      .values({ id: 1, cursor: next })
      .onConflictDoUpdate({ target: regroupProgress.id, set: { cursor: next } });
  }
  return { keys: keys.length, changed, next };
}

/**
 * Where an incremental pass starts: the last complete pass, less REGROUP_MARGIN. The margin covers a write
 * stamped with an earlier `now` than the one it commits under, and a pass that overlaps a sync. A first
 * pass (no cursor yet) looks back DEDUPE_WINDOW.
 */
async function freshRegroupCursor(db: Db, now: number): Promise<IncrementalCursor> {
  const since = Math.max(0, await regroupSince(db, now));
  return {
    at: now,
    since,
    phase: "updated",
    updatedAt: since,
    id: 0,
    duplicateId: 0,
    source: "",
    posting: "",
  };
}

/** The unfinished pass's cursor, or undefined. A stored value that no longer parses starts a new pass instead. */
async function storedRegroupCursor(db: Db, now: number): Promise<IncrementalCursor | undefined> {
  const [row] = await db
    .select({ cursor: regroupProgress.cursor })
    .from(regroupProgress)
    .where(eq(regroupProgress.id, 1))
    .limit(1);
  if (!row) return undefined;
  try {
    return resumeRegroup(row.cursor, now);
  } catch {
    console.warn("Invalid stored regroup cursor; restarting incremental pass");
    return undefined;
  }
}

async function regroupSince(db: Db, now: number): Promise<number> {
  const [row] = await db
    .select({ checkedAt: regroupState.checkedAt })
    .from(regroupState)
    .where(eq(regroupState.id, 1))
    .limit(1);
  return row ? row.checkedAt - REGROUP_MARGIN : now - DEDUPE_WINDOW;
}
