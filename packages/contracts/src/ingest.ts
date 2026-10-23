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
  /** Tri-state heuristics: 1 yes, 0 no, null unknown. */
  isUs: z.union([z.literal(0), z.literal(1)]).nullable(),
  isTech: z.union([z.literal(0), z.literal(1)]).nullable(),
  classifierVersion: z.number().int().positive(),
  department: z.string().max(200).nullable(),
  team: z.string().max(200).nullable(),
  employmentType: z.string().max(100).nullable(),
  requisitionId: z.string().max(200).nullable(),
  postedAt: epoch.nullable(),
  sourceUpdatedAt: epoch.nullable(),
  expiresAt: epoch.nullable(),
  salaryMinAnnual: z.number().nonnegative().nullable(),
  salaryMaxAnnual: z.number().nonnegative().nullable(),
  salaryCurrency: z.string().max(8).nullable(),
  expMinYears: z.number().nonnegative().nullable(),
  expMaxYears: z.number().nonnegative().nullable(),
  excerpt: z.string().max(400),
  jdHash: hex64,
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
  postings: z
    .array(z.object({ id: z.string().min(1).max(512), hash: hex64 }))
    .max(5000),
});
export type DiffRequest = z.infer<typeof diffSchema>;

export const jobsBatchSchema = z.object({ jobs: z.array(jobFactsSchema).min(1).max(200) });
export type JobsBatch = z.infer<typeof jobsBatchSchema>;

export const blobCheckSchema = z.object({ hashes: z.array(hex64).max(1000) });

const issueSchema = z.object({
  code: z.enum(["http", "schema", "pagination", "budget", "detail"]),
  message: z.string().max(500),
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
});
export type Finalize = z.infer<typeof finalizeSchema>;

export interface FinalizeResult {
  status: "complete" | "partial";
  closureApplied: boolean;
  closed: number;
  reopened: number;
}

export const CLOSE_AFTER_ABSENT_RUNS = 2;
