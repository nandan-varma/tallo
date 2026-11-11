/** How many results a search lists, in total. Rank has no keyset, so paging stops here; there is no count. */
export const SEARCH_RESULT_CAP = 300;

/**
 * What a search is: title phrases, optionally the companies and the places. The results list is the database's
 * answer to it, so the list depends only on what the person typed. Places are the person's own words; the server
 * expands them.
 */
export interface SearchSpec {
  queries: string[];
  companies?: string[];
  locations?: string[];
}

/** One search hit: only what a person skims in a list. A null field is unknown, never guessed. */
export interface JobHit {
  id: string;
  title: string;
  company: string;
  location: string | null;
  workMode: string | null;
  /** The source's stated base pay with its own interval ("USD 90000-95000 per hour"), or null. */
  pay: string | null;
  /** `YYYY-MM-DD`, or null. */
  postedAt: string | null;
  department: string | null;
  /** Where to apply: the employer's own application page (the source's apply link, else its posting page), or null. */
  applyUrl: string | null;
  /**
   * Postings of this requisition (or, without a requisition id, this company and title) among the search's
   * candidates, this one included. Above 1, the same role is open in several places and the hit shows the best-ranked.
   */
  locations: number;
}

/** One page of the internal search: `nextOffset` is null on the last page; there is no total count. */
export interface SearchPage {
  hits: JobHit[];
  nextOffset: number | null;
}
