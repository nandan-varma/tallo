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
