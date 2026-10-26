import { z } from "zod";
import { type SearchSpec, searchSpecSchema } from "./ai.ts";

/** Body of `POST /v1/searches`: keep this search so it can be run again and watched for new roles. */
export const saveSearchSchema = z.object({
  name: z.string().trim().min(1).max(80),
  spec: searchSpecSchema,
});

/** How many of a search's newest roles to look at when counting what is new. */
export const NEW_WINDOW = 30;

export interface SavedSearch {
  id: number;
  name: string;
  spec: SearchSpec;
  /** Unix seconds. */
  createdAt: number;
  /** When the person last ran it. Roles posted after this count as new. */
  seenAt: number;
  /** Roles among the search's newest `NEW_WINDOW` that were posted after `seenAt`. */
  newCount: number;
  /** True when every one of the newest `NEW_WINDOW` is new, so the real count may be higher. */
  newCapped: boolean;
}
