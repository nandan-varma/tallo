import { z } from "zod";

/** How many results a search lists, in total. Rank has no keyset, so paging stops here; there is no count. */
export const SEARCH_RESULT_CAP = 300;

/**
 * What a search is: title phrases, optionally the companies and the places. The results list is the database's
 * answer to it, so the list depends only on what the person typed. Places are the person's own words; the server
 * expands them.
 */
export const searchSpecSchema = z.object({
  queries: z
    .array(z.string().min(2).max(80))
    .min(1)
    .max(8)
    .describe(
      'Title phrases, for example "backend engineer", "platform engineer". Never one generic word. Leave the company out of them.',
    ),
  companies: z
    .array(z.string().min(2).max(80))
    .max(4)
    .optional()
    .describe(
      'Companies the person named, for example ["Stripe"]. Matched on the company name, ANDed with the titles. Leave out when no company was named.',
    ),
  locations: z
    .array(z.string().min(2).max(60))
    .max(8)
    .optional()
    .describe(
      'The places the person named, in their own words ("NYC", "Bay Area", "Washington", "remote"). The server expands them. Leave out when the person did not name a place.',
    ),
});
export type SearchSpec = z.infer<typeof searchSpecSchema>;

/** Body of `POST /v1/jobs/search`: one page of the database's answer to a spec, most relevant first. */
export const searchPageSchema = searchSpecSchema.extend({
  offset: z
    .number()
    .int()
    .min(0)
    .max(SEARCH_RESULT_CAP - 1)
    .default(0),
  limit: z.number().int().min(1).max(30).default(20),
});

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

/** `POST /v1/jobs/search`: one page of hits. `nextOffset` is null on the last page; there is no total count. */
export interface SearchPage {
  hits: JobHit[];
  nextOffset: number | null;
}
