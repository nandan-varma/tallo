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
  /** Resume text pasted before the builder existed. Only offered as a starting point for an import. */
  resume: string;
  /** Unix seconds. */
  updatedAt: number;
}

/**
 * What a search is: title phrases, and optionally the places the job must be in. The assistant fills this in
 * (its `search_jobs` tool takes exactly this), and the results list is the database's answer to it, so the
 * list never depends on what a model wrote.
 */
export const searchSpecSchema = z.object({
  queries: z
    .array(z.string().min(2).max(80))
    .min(1)
    .max(8)
    .describe(
      'Title phrases, for example "backend engineer", "platform engineer". Never one generic word.',
    ),
  locations: z
    .array(z.string().min(2).max(60))
    .max(8)
    .optional()
    .describe(
      'Require the job to be in one of these places (any may match): cities, state names AND abbreviations, "remote". For Washington state: ["Seattle", "Bellevue", "Redmond", "Washington", "WA"]. Leave out when the person did not name a place.',
    ),
});
export type SearchSpec = z.infer<typeof searchSpecSchema>;

/** Body of `POST /v1/jobs/search`: one page of the database's answer to a spec, newest first. */
export const searchPageSchema = searchSpecSchema.extend({
  cursor: z
    .string()
    .regex(/^\d+\.\d+$/)
    .optional(),
  limit: z.number().int().min(1).max(30).default(20),
});
