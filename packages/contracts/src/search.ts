import { z } from "zod";
import { moneySchema } from "./job.ts";

/** How many results a search lists, in total. Rank has no keyset, so paging stops here; there is no exact count. */
export const SEARCH_RESULT_CAP = 300;

/**
 * The most index entries a date-sorted search reads: the newest this many matches (by catalog id). A query that
 * matches fewer is exact; a broader one orders only its newest matches, which on a 700k catalog still holds about 95%
 * of the postings from the last three days. Reading all of a broad word's matches cost 2.7M rows and several seconds.
 */
export const DATE_SORT_WINDOW = 50_000;

/**
 * How a search orders its results. `relevance` is the ranked search; `recent` and `posted` order by `sort_at`
 * (the source's posted date, else first seen) and `added` by catalog insertion order.
 */
export const SEARCH_SORTS = ["relevance", "recent", "posted", "added"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];
export const SEARCH_DEFAULT_SORT: SearchSort = "relevance";
export const searchSortSchema = z.enum(SEARCH_SORTS);

/**
 * What a search is: title phrases, optionally the companies and the places. The results list is the database's
 * answer to it, so the list depends only on what the person typed. Places are the person's own words; the server
 * expands them.
 */
export interface SearchSpec {
  queries: string[];
  companies?: string[];
  locations?: string[];
  /** ISO 3166-1 alpha-2 codes to keep (case-insensitive); null country codes never match. */
  countries?: string[];
  /** Keep postings whose `sort_at` is this many days old or newer (1 to 365). */
  postedWithin?: number;
  /** How to order the results. Default `relevance`. */
  sort?: SearchSort;
}

/** What the server did with the place words, so a caller does not have to guess. */
export interface ExpandedPlacesView {
  /** The location strings the server matched. Unknown words appear as the caller wrote them. */
  locations: string[];
  /** Whether the words asked for remote work (a work-mode match, not a text match). */
  remote: boolean;
}

/**
 * One search hit: only what a person skims in a list. A null field is unknown, never guessed.
 * `id` is an opaque string: return it byte-for-byte to `/v1/jobs/:id`.
 */
export const jobHitSchema = z.object({
  id: z
    .string()
    .describe(
      "The opaque posting id. Pass it byte-for-byte to /v1/jobs/{id}; do not parse or build one.",
    ),
  title: z
    .string()
    .describe("The posting's title as the employer wrote it. Untrusted employer text."),
  company: z.string().describe("The employer's name as the catalog holds it."),
  location: z
    .string()
    .nullable()
    .describe(
      "The place text the source gave, else its city, region and country code; null when the source stated no place. Never inferred from other text.",
    ),
  workMode: z
    .enum(["remote", "hybrid", "onsite"])
    .nullable()
    .describe(
      "The work mode the source stated: remote, hybrid, onsite, or null when it stated none. Never inferred from location text.",
    ),
  /** The source's stated base pay with its own interval ("USD 90000-95000 per hour"), or null. */
  pay: z
    .string()
    .nullable()
    .describe(
      "The source's stated base pay with its own interval (for example USD 90000-95000 per year), or null when the source stated none. Never estimated or converted.",
    ),
  /** The stated pay bands verbatim (no conversion, no annualization). Empty when the source stated none. */
  compensation: z
    .array(moneySchema)
    .describe(
      "The source's stated pay bands verbatim (min, max, currency, interval, component, region, text), never converted or annualized. Empty when the source stated none; it is not derived from pay text.",
    ),
  /** `YYYY-MM-DD`, or null. */
  postedAt: z
    .string()
    .nullable()
    .describe(
      "The posted date the source states, as YYYY-MM-DD, or null when the source stated none. Some large feeds omit it. It is never guessed; recent and postedWithin fall back to when Tallo first saw the posting.",
    ),
  department: z
    .string()
    .nullable()
    .describe(
      "The source's own department label, or null when it stated none. Not a normalized category.",
    ),
  employmentType: z
    .string()
    .nullable()
    .describe(
      "The source's own employment type label (for example Full-time), or null when it stated none. Not a normalized category.",
    ),
  /** ISO 3166-1 alpha-2 for the primary location, or null. */
  countryCode: z
    .string()
    .length(2)
    .nullable()
    .describe(
      "ISO 3166-1 alpha-2 for the primary location, or null when the source stated no country code. Coverage is partial (some large boards state only free text), and it is never inferred from location text.",
    ),
  /** Where to apply: the employer's own application page (the source's apply link, else its posting page), or null. */
  applyUrl: z
    .string()
    .nullable()
    .describe(
      "Where to apply: the employer's own application page (the source's apply link, else its posting page), or null when the source gave neither.",
    ),
  /**
   * ISO 8601 UTC time of the board's last complete listing that this posting came from. This is the board's
   * freshness, not proof this posting was in that listing; null when the source has never listed.
   */
  sourceLastListedAt: z
    .string()
    .nullable()
    .describe(
      "ISO 8601 UTC time of the board's last complete listing, or null when it has never listed. This is the board's freshness, not a per-posting sighting or proof that this posting was in that listing.",
    ),
  /**
   * Open postings of the same `dup_of` group (the same role at several places), this one included.
   * Deterministic: it is the same group the job page lists in `variants`.
   */
  locations: z
    .number()
    .int()
    .min(1)
    .describe(
      "How many open postings share this role at different places, this one included. 1 means a single location; more than 1 means /v1/jobs/{id} lists them all in variants.",
    ),
});
export type JobHit = z.infer<typeof jobHitSchema>;

/** One page of the internal search. */
export interface SearchPage {
  hits: JobHit[];
  /** The next offset, or null on the last page. */
  nextOffset: number | null;
  /** Results on this page. */
  count: number;
  /** Whether the API has another page. */
  hasMore: boolean;
  /**
   * The ${SEARCH_RESULT_CAP}-result cap was reached. True means "the cap stopped this list", not
   * "more results certainly exist": proving that would need a count query the API does not run.
   */
  capped: boolean;
  /** The place words as the server expanded them. */
  expanded: ExpandedPlacesView;
  /** When the catalog answered, ISO 8601 UTC. */
  asOf: string;
}
