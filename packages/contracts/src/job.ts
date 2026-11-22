import { z } from "zod";
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
  /**
   * True only for a value parsed from free text. No platform map sets it, and the pay line never uses it:
   * the database stores what the source stated.
   */
  inferred?: boolean;
}

export const payIntervalSchema = z.enum([
  "year",
  "month",
  "week",
  "day",
  "hour",
  "once",
  "unknown",
]);
export type PayInterval = z.infer<typeof payIntervalSchema>;

/** One stated pay band. The public API exposes these verbatim; it never converts or annualizes them. */
export const moneySchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  currency: z.string().optional(),
  interval: payIntervalSchema,
  component: z.enum(["base", "bonus", "equity", "total", "unknown"]),
  /** Geography this band applies to, when the source scopes it. */
  region: z.string().optional(),
  text: z.string().optional(),
  /**
   * True only for a value parsed from free text. No platform map sets it, and the pay line never uses it:
   * the database stores what the source stated.
   */
  inferred: z.boolean().optional(),
});
export type Money = z.infer<typeof moneySchema>;

/**
 * The words a title is made of, lowercase, punctuation as separators, one to forty characters each. Raw tokens:
 * no stemming and no stop-word removal, because this only feeds discovery (`/v1/titles`).
 */
export function titleTokens(title: string): string[] {
  const tokens = title.toLowerCase().match(/[\p{L}\p{N}]{2,40}/gu) ?? [];
  return [...new Set(tokens)];
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

/** Intervals a pay line can state. "once" and "unknown" are not a rate, so they never make a pay line. */
const RATE_INTERVALS: PayInterval[] = ["year", "month", "week", "day", "hour"];

/**
 * The pay line a result shows, in the interval the source stated: "USD 90000-95000 per hour". Only base
 * pay the source stated (not inferred from text) with a rate interval counts; the first such band wins.
 * Null when there is none.
 */
export function payText(compensation: Money[] | undefined): string | null {
  const band = (compensation ?? []).find(
    (b) =>
      !b.inferred &&
      b.component === "base" &&
      RATE_INTERVALS.includes(b.interval) &&
      (b.min !== undefined || b.max !== undefined),
  );
  if (!band) return null;
  const { min, max } = band;
  const amount =
    min !== undefined && max !== undefined
      ? min === max
        ? `${min}`
        : `${min}-${max}`
      : min !== undefined
        ? `${min}+`
        : `up to ${max}`;
  const line = [band.currency, amount, `per ${band.interval}`].filter(Boolean).join(" ");
  return band.region ? `${line} (${band.region})` : line;
}
