import { z } from "zod";
import { type SearchSpec, searchSpecSchema } from "./ai.ts";

/** Body of `POST /v1/searches`: keep this search so it can be run again and watched for new roles. */
export const saveSearchSchema = z.object({
  name: z.string().trim().min(1).max(80),
  spec: searchSpecSchema,
});

/** The most roles a saved search counts as new. The count reads the same capped candidates as the search. */
export const NEW_WINDOW = 30;

export interface SavedSearch {
  id: number;
  name: string;
  spec: SearchSpec;
  /** Unix seconds. */
  createdAt: number;
  /** When the person last ran it. Roles posted after this count as new. */
  seenAt: number;
  /** Roles among the search's best matches (capped) that were posted after `seenAt`, at most `NEW_WINDOW`. */
  newCount: number;
  /** True when the count reached `NEW_WINDOW`, so the real count may be higher. */
  newCapped: boolean;
}
