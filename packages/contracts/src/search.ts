import { z } from "zod";
import { moneySchema } from "./job.ts";

/** How many results a search lists, in total. Rank has no keyset, so paging stops here; there is no exact count. */
export const SEARCH_RESULT_CAP = 300;

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
  id: z.string(),
  title: z.string(),
  company: z.string(),
  location: z.string().nullable(),
  workMode: z.enum(["remote", "hybrid", "onsite"]).nullable(),
  /** The source's stated base pay with its own interval ("USD 90000-95000 per hour"), or null. */
  pay: z.string().nullable(),
  /** The stated pay bands verbatim (no conversion, no annualization). Empty when the source stated none. */
  compensation: z.array(moneySchema),
  /** `YYYY-MM-DD`, or null. */
  postedAt: z.string().nullable(),
  department: z.string().nullable(),
  employmentType: z.string().nullable(),
  /** ISO 3166-1 alpha-2 for the primary location, or null. */
  countryCode: z.string().length(2).nullable(),
  /** Where to apply: the employer's own application page (the source's apply link, else its posting page), or null. */
  applyUrl: z.string().nullable(),
  /**
   * ISO 8601 UTC time of the board's last complete listing that this posting came from. This is the board's
   * freshness, not proof this posting was in that listing; null when the source has never listed.
   */
  sourceLastListedAt: z.string().nullable(),
  /**
   * Open postings of the same `dup_of` group (the same role at several places), this one included.
   * Deterministic: it is the same group the job page lists in `variants`.
   */
  locations: z.number().int().min(1),
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
