import { z } from "zod";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const epoch = z.number().int().nonnegative();

/** Wire form of one job: catalog-derived facts plus blob references. No description text. */
export const jobFactsSchema = z.object({
  postingId: z.string().min(1).max(512),
  title: z.string().min(1).max(500),
  url: z.string().max(2048).nullable(),
  applyUrl: z.string().max(2048).nullable(),
  locationText: z.string().max(500).nullable(),
  city: z.string().max(120).nullable(),
  region: z.string().max(120).nullable(),
  countryCode: z.string().length(2).nullable(),
  workMode: z.enum(["remote", "hybrid", "onsite"]).nullable(),
  department: z.string().max(200).nullable(),
  team: z.string().max(200).nullable(),
  employmentType: z.string().max(100).nullable(),
  requisitionId: z.string().max(200).nullable(),
  postedAt: epoch.nullable(),
  sourceUpdatedAt: epoch.nullable(),
  expiresAt: epoch.nullable(),
  excerpt: z.string().max(400),
  jdHash: hex64,
  /** Groups listings of one posting (see catalog `dedupeKey`). Required from every current collector. */
  dedupeKey: hex64,
  jdBytes: z.number().int().nonnegative(),
  /** Fingerprint of the source listing + platform version; equal means no write is needed. */
  sourceHash: hex64,
  /** Rich typed detail (all locations, compensation components, experience, extras). */
  facts: z.record(z.string(), z.unknown()),
});
export type JobFacts = z.infer<typeof jobFactsSchema>;

export const createRunSchema = z.object({
  runId: z.string().min(8).max(64),
  source: z.object({
    id: z.string().min(1).max(200),
    platform: z.string().min(1).max(50),
    key: z.string().min(1).max(300),
    company: z.string().min(1).max(200),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }),
  runnerId: z.string().min(1).max(100),
  collectorVersion: z.string().min(1).max(50),
  startedAt: epoch,
});
export type CreateRun = z.infer<typeof createRunSchema>;

export const diffSchema = z.object({
  postings: z.array(z.object({ id: z.string().min(1).max(512), hash: hex64 })).max(50000),
});

export const jobsBatchSchema = z.object({ jobs: z.array(jobFactsSchema).min(1).max(200) });

export const blobCheckSchema = z.object({ hashes: z.array(hex64).max(1000) });

const issueSchema = z.object({
  code: z.enum(["http", "schema", "pagination", "budget", "detail", "blocked", "gone"]),
  message: z.string().max(500),
  retryable: z.boolean().optional(),
  status: z.number().int().min(100).max(599).optional(),
  retryAfterMs: z.number().nonnegative().optional(),
  url: z.string().max(500).optional(),
  postingId: z.string().max(512).optional(),
});

export const finalizeSchema = z.object({
  /** Every posting id the collection observed (listed), changed or not. */
  seenIds: z.array(z.string().min(1).max(512)).max(200000),
  listingComplete: z.boolean(),
  detailsComplete: z.boolean(),
  emptyIsAuthoritative: z.boolean(),
  requests: z.number().int().nonnegative(),
  finishedAt: epoch,
  rawKey: z.string().max(300).nullable(),
  issues: z.array(issueSchema).max(50),
  /**
   * The listing failed because the board does not exist: HTTP 404 on the first request. Counts toward
   * dead. A redirect off the allowlist is not a 404 (it can be egress being refused): it is a blocked run.
   */
  boardNotFound: z.boolean().default(false),
  /**
   * The listing answered 304 to the validator stored by the last complete run: nothing was listed and
   * nothing changed. The run counts as a complete listing for freshness and scheduling, but never
   * closes, ages or reopens a job. The server accepts it only when `validator` equals the stored one.
   */
  notModified: z.boolean().default(false),
  /**
   * The listing validator to keep for the next run (versioned by the engine, opaque here). Stored only
   * when the listing was complete and every posting was applied; any other run clears the stored one.
   */
  validator: z.string().max(400).nullish(),
});
export type Finalize = z.infer<typeof finalizeSchema>;
/** What a caller may pass: the fields with a default can be left out. */
export type FinalizeInput = z.input<typeof finalizeSchema>;

/**
 * Diff and, when nothing changed, finalize, in one call. `finish` is the finalize body the run would send
 * if the diff comes back empty; the ids it would carry as `seenIds` are the diffed postings, and there is
 * no raw pack (nothing was mapped).
 */
export const diffOrFinishSchema = diffSchema.extend({
  finish: finalizeSchema.omit({ seenIds: true, rawKey: true }),
});

export interface FinalizeResult {
  status: "complete" | "partial";
  closureApplied: boolean;
  closed: number;
  reopened: number;
}

/** What `startRun` tells the collector: the validator stored for the source, if one is still valid. */
export interface StartedRun {
  validator: string | null;
}

export const CLOSE_AFTER_ABSENT_RUNS = 2;

/** A board that 404s this many runs in a row is marked dead and skipped by sync. */
export const DEAD_AFTER_NOT_FOUND_RUNS = 3;

const DAY = 86_400;

/**
 * Seconds to wait between runs of a board whose complete listings stay empty, by how long it has
 * been empty (`lastPostingsAt` is the last run that listed any postings, null if none is retained).
 * Under a week: every normal run. A week to a month: every three days. Longer, or never listed: weekly.
 * A skipped run never closes anything (closure needs complete listings); it only delays one.
 * Pure: the Mac runner and any Worker scheduler call the same function.
 */
export function emptyBackoffSeconds(
  lastPostingsAt: number | null | undefined,
  now: number,
): number {
  const empty = lastPostingsAt == null ? Number.POSITIVE_INFINITY : now - lastPostingsAt;
  if (empty < 7 * DAY) return 0;
  return empty < 30 * DAY ? 3 * DAY : 7 * DAY;
}

/** A source with no successful listing for this long is flagged, then hidden from search. */
export const STALE_FLAG_DAYS = 7;
export const STALE_HIDE_DAYS = 14;

/** Bounds on one reviewed retirement request (Worker and D1 read work per call). */
export const RETIRE_MAX_SOURCES = 10;
export const RETIRE_MAX_ROWS = 5000;

/**
 * What a retirement did (or, for a dry run, would do). `rawKeys` are the retiring sources' own run
 * packs; `orphanJdHashes` are descriptions no catalog row references any more. Both are audit and
 * cleanup candidates, not deletion instructions: retention owns R2.
 */
export interface RetireResult {
  sources: string[];
  jobs: number;
  rawKeys: string[];
  orphanJdHashes: string[];
  dryRun: boolean;
}

/** Shared response from the HTTP and direct-binding ingest adapters. */
export const applyResultSchema = z.object({
  applied: z.number().int().nonnegative(),
  missingBlobs: z.array(hex64),
  invalid: z.array(z.object({ postingId: z.string(), reason: z.string() })),
  bounded: z.array(z.object({ postingId: z.string(), notes: z.array(z.string()) })),
});
export type ApplyResult = z.infer<typeof applyResultSchema>;
