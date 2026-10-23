import type { JsonObject } from "./json.ts";

/**
 * A stated quantity that preserves the source's own semantics.
 * "3+ years" is {min: 3, kind: "required"}; it is never rewritten into a range or midpoint.
 */
export interface Quantity {
  min?: number;
  max?: number;
  exact?: number;
  unit: "years" | "months";
  kind: "required" | "preferred" | "stated";
  /** Source text this was read from, for audit. */
  text?: string;
  /** True when parsed from free text rather than a structured source field. */
  inferred?: boolean;
}

export type PayInterval = "year" | "month" | "week" | "day" | "hour" | "once" | "unknown";

export interface Money {
  min?: number;
  max?: number;
  currency?: string;
  interval: PayInterval;
  component: "base" | "bonus" | "equity" | "total" | "unknown";
  /** Geography this band applies to, when the source scopes it. */
  region?: string;
  text?: string;
  /** True when parsed from free text rather than a structured source field. */
  inferred?: boolean;
}

export interface JobLocation {
  text: string;
  city?: string;
  region?: string;
  country?: string;
  /** ISO 3166-1 alpha-2 when known. */
  countryCode?: string;
  remote?: boolean;
  primary?: boolean;
}

export type WorkMode = "remote" | "hybrid" | "onsite";

/**
 * Platform-neutral job produced by a platform's pure `map`. Unknown facts are omitted (NULL).
 * Anything the source gave that has no typed home goes to `extras`; the full original record
 * is always retained separately as raw evidence.
 */
export interface MappedJob {
  postingId: string;
  title: string;
  url?: string;
  applyUrl?: string;
  /** Plain text only. */
  description: string;
  locations: JobLocation[];
  workMode?: WorkMode;
  department?: string;
  team?: string;
  /** As the source labels it. */
  employmentType?: string;
  requisitionId?: string;
  postedAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  compensation: Money[];
  experience: Quantity[];
  extras: JsonObject;
}

/** 1 when heuristics are confident a job is out of the public scope (non-US or non-tech). */
export const outOfScope = (flags: { isUs: 0 | 1 | null; isTech: 0 | 1 | null }): 0 | 1 =>
  flags.isUs === 0 || flags.isTech === 0 ? 1 : 0;

/** Read model: one row in a result list. */
export interface JobSummary {
  id: number;
  title: string;
  applyUrl: string | null;
  url: string | null;
  company: string;
  companySlug: string;
  locationText: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  workMode: WorkMode | null;
  department: string | null;
  employmentType: string | null;
  /** Epoch seconds. */
  postedAt: number | null;
  salaryMinAnnual: number | null;
  salaryMaxAnnual: number | null;
  salaryCurrency: string | null;
  expMinYears: number | null;
  excerpt: string;
  sortAt: number;
}

export interface JobPage {
  jobs: JobSummary[];
  nextCursor: string | null;
}

/** Read model: one job with its full description text. */
export interface JobDetail extends JobSummary {
  team: string | null;
  requisitionId: string | null;
  expMaxYears: number | null;
  description: string | null;
  /** Rich typed detail: all locations, pay components, experience, extras. */
  facts: Record<string, unknown>;
}
