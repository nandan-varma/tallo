import { z } from "zod";

const RESUME_MAX = 60_000;
const PROFILE_MAX = 30_000;

/** Body of `PUT /v1/profile`: the user's resume and the profile markdown they approved. */
export const saveProfileSchema = z.object({
  resume: z.string().max(RESUME_MAX),
  profile: z.string().max(PROFILE_MAX),
});

/** Body of `POST /v1/profile/generate`: resume text in, profile markdown out (nothing is stored). */
export const generateProfileSchema = z.object({
  resume: z.string().trim().min(20, "Paste your resume first.").max(RESUME_MAX),
});

/** `GET /v1/profile`. `null` until the first save. */
export interface ProfileRecord {
  resume: string;
  profile: string;
  /** Unix seconds. */
  updatedAt: number;
}
