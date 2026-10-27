import { z } from "zod";

/**
 * Everything a resume says. Plain strings, so a model can write it and a person can edit it. The bounded form
 * guards storage and requests; models get the unbounded form (providers differ on which JSON-schema limits
 * they accept) and their output is then checked against the bounded one.
 */
function makeResumeSchema(bounded: boolean) {
  const line = (max: number) => (bounded ? z.string().max(max) : z.string());
  const lines = (max: number, count: number) => {
    const list = z.array(line(max));
    return bounded ? list.max(count) : list;
  };
  const list = <T extends z.ZodType>(item: T, count: number) => {
    const array = z.array(item);
    return bounded ? array.max(count) : array;
  };
  return z.object({
    name: line(100),
    headline: line(150),
    email: line(120),
    phone: line(40),
    location: line(100),
    links: list(z.object({ label: line(40), url: line(300) }), 8),
    summary: line(1_500),
    experience: list(
      z.object({
        company: line(120),
        title: line(120),
        location: line(100),
        start: line(30),
        end: line(30),
        bullets: lines(600, 12),
      }),
      20,
    ),
    education: list(
      z.object({
        school: line(150),
        degree: line(150),
        location: line(100),
        start: line(30),
        end: line(30),
        details: lines(400, 6),
      }),
      8,
    ),
    skills: list(z.object({ label: line(60), items: lines(60, 40) }), 10),
    projects: list(z.object({ name: line(120), url: line(300), bullets: lines(600, 6) }), 10),
    /** Anything else worth a section: certifications, awards, publications, volunteering. */
    extras: list(z.object({ title: line(60), items: lines(300, 12) }), 5),
  });
}

export const resumeSchema = makeResumeSchema(true);
/** The same shape without length limits, for model output. */
export const modelResumeSchema = makeResumeSchema(false);
export type Resume = z.infer<typeof resumeSchema>;

/** How the resume is drawn. Kept apart from the words so a model never touches it. */
export const resumeStyleSchema = z.object({
  template: z.enum(["classic", "modern"]).default("classic"),
  paper: z.enum(["letter", "a4"]).default("letter"),
  /** Pages the layout may use; the renderer picks the roomiest density that fits. */
  pages: z.number().int().min(1).max(2).default(1),
  accent: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .default("#1f2937"),
});
export type ResumeStyle = z.infer<typeof resumeStyleSchema>;

/** What is stored per resume and sent to `PUT /v1/resume`. */
export const resumeDocSchema = z.object({
  resume: resumeSchema,
  style: resumeStyleSchema.default(() => resumeStyleSchema.parse({})),
  coverLetter: z.string().max(6000).default(""),
});
export type ResumeDoc = z.infer<typeof resumeDocSchema>;

/** `GET /v1/resume`. `jobId` null is the base resume; a number is the copy tailored to that posting. */
export interface ResumeRecord {
  jobId: number | null;
  doc: ResumeDoc;
  /** Unix seconds. */
  updatedAt: number;
}

/** One entry of `GET /v1/resumes`: the base resume and every tailored copy, newest first. */
export interface ResumeSummary {
  jobId: number | null;
  /** Posting title and company, when the posting is still in the catalog. */
  title: string | null;
  company: string | null;
  updatedAt: number;
}

const RESUME_TEXT_MAX = 60_000;

/** Body of `POST /v1/resume/import`: the text of an existing resume, to be turned into structured data. */
export const importResumeSchema = z.object({
  text: z.string().trim().min(20, "Paste or upload your resume first.").max(RESUME_TEXT_MAX),
});

/** Body of `POST /v1/resume/tailor`: rewrite this resume for that posting, changing no facts. */
export const tailorResumeSchema = z.object({
  jobId: z.number().int().positive(),
  resume: resumeSchema,
});

/** Body of `POST /v1/resume/edit`: apply one instruction to the resume. */
export const editResumeSchema = z.object({
  resume: resumeSchema,
  instruction: z.string().trim().min(3, "Say what to change.").max(1_000),
});

/** How well a resume fits a posting. Quotes are checked against both texts before they reach the person. */
export const fitSchema = z.object({
  verdict: z.enum(["strong", "good", "stretch", "weak"]),
  summary: z.string(),
  matches: z.array(z.object({ requirement: z.string(), evidence: z.string() })),
  gaps: z.array(z.object({ requirement: z.string(), advice: z.string() })),
});
export type Fit = z.infer<typeof fitSchema>;

/** What the AI endpoints answer: the new resume plus a short list of what changed, for the person to review. */
export interface ResumeEdit {
  resume: Resume;
  changes: string[];
}

export const emptyResume = (): Resume => ({
  name: "",
  headline: "",
  email: "",
  phone: "",
  location: "",
  links: [],
  summary: "",
  experience: [],
  education: [],
  skills: [],
  projects: [],
  extras: [],
});

export const defaultResumeDoc = (): ResumeDoc => ({
  resume: emptyResume(),
  style: resumeStyleSchema.parse({}),
  coverLetter: "",
});

/** Interview prep for one posting: likely questions with answers drawn from the resume, and questions to ask them. */
export const prepSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      angle: z.string(),
      evidence: z.string(),
    }),
  ),
  ask: z.array(z.string()),
});
export type Prep = z.infer<typeof prepSchema>;
