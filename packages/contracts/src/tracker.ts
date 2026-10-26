import { z } from "zod";

/** Where a role stands for the person, in the order a search moves through them. */
export const APPLICATION_STATUSES = [
  "saved",
  "applied",
  "interviewing",
  "offer",
  "rejected",
] as const;
export const applicationStatusSchema = z.enum(APPLICATION_STATUSES);
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;

/** Body of `PUT /v1/applications/:jobId`. An omitted `note` keeps the note already there. */
export const setApplicationSchema = z.object({
  status: applicationStatusSchema,
  note: z.string().max(2_000).optional(),
});

/**
 * One tracked role. The posting's title, company, place and apply address are copied when it is first tracked,
 * because the posting itself is purged some weeks after it closes and the tracker must outlive that.
 */
export interface Application {
  jobId: number;
  status: ApplicationStatus;
  note: string;
  title: string;
  company: string;
  location: string | null;
  applyUrl: string | null;
  /** Unix seconds. */
  createdAt: number;
  updatedAt: number;
  /** When the status first became `applied`; null for a role that was only saved. */
  appliedAt: number | null;
}
