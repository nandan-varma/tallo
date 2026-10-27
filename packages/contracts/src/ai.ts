import { z } from "zod";

const NOTES_MAX = 30_000;

/**
 * Body of `PUT /v1/profile`: what the person tells the assistant about themselves beyond their resume
 * (target roles, pay, places, deal-breakers). Free text; the resume itself is read from the builder.
 */
export const saveProfileSchema = z.object({
  profile: z.string().max(NOTES_MAX),
});

/** `GET /v1/profile`. `null` until the first save. */
export interface ProfileRecord {
  profile: string;
  /** Unix seconds. */
  updatedAt: number;
}

/** How many results a search lists, in total. Rank has no keyset, so paging stops here; there is no count. */
export const SEARCH_RESULT_CAP = 300;

/**
 * What a search is: title phrases, optionally the companies and the places. The assistant fills this in (its
 * `search_jobs` tool takes exactly this), and the results list is the database's answer to it, so the list never
 * depends on what a model wrote. Places are the person's own words; the server expands them.
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
