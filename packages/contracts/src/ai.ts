import { z } from "zod";

/** Body of `POST /v1/ai/ask`. Stateless: nothing in it is stored. */
export const askSchema = z.object({
  query: z.string().trim().min(1).max(500),
  /** Markdown profile the search fits jobs against. Optional; empty means no profile. */
  profile: z.string().max(20_000).optional(),
  /** Descriptions read in full, judged one job at a time. */
  deepReads: z.number().int().min(0).max(15).optional(),
});
export type AskInput = z.infer<typeof askSchema>;
