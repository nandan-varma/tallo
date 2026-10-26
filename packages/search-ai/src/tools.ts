import { tool } from "ai";
import { z } from "zod";
import type { JobsPort } from "./jobs.ts";

export const MAX_QUERIES = 8;
export const MAX_LOCATIONS = 8;
export const SEARCH_LIMIT = 40;
export const MAX_MATCHES = 30;

const Match = z.object({
  id: z.string().describe("The id of a job returned by search_jobs."),
  verdict: z
    .enum(["strong", "maybe"])
    .describe("strong: clearly fits. maybe: plausible, something is unknown."),
  fit: z
    .number()
    .int()
    .min(0)
    .max(100)
    .nullable()
    .describe("0-100, only for a job you read in full; else null."),
  reason: z.string().describe("One sentence: why this job fits this person."),
  evidence: z
    .array(z.string())
    .max(3)
    .describe(
      "Exact quotes, copied character for character, from a description you read or the profile.",
    ),
  unknowns: z
    .array(z.string())
    .max(4)
    .describe("What the person would want to know that the posting does not say."),
});
export type Match = z.infer<typeof Match>;

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** A quote counts only if it appears word for word (whitespace and case aside) in a source we actually have. */
const isVerbatim = (quote: string, sources: (string | undefined)[]) => {
  const needle = squash(quote);
  return (
    needle.length > 0 &&
    sources.some((source) => source !== undefined && squash(source).includes(needle))
  );
};

/**
 * The agent's three tools. Each does one thing; the model decides when to use them:
 * search_jobs (cheap, many), read_job (deep, rare, full text) and show_jobs (publishes the ranking
 * to the results panel). Created per request: `descriptions` holds the full text read in this turn.
 */
export function createTools({ jobs, profile }: { jobs: JobsPort; profile: string }) {
  const descriptions = new Map<string, string>();

  return {
    search_jobs: tool({
      description:
        "Search the catalog of open US tech jobs. Pass several title phrases of two or three words that the person could realistically hold, and the places they want: the search can require a place, and without one it returns the newest matches anywhere. Returns up to 40 compact hits (title, company, location, work mode, pay, posted date, department); a null field is unknown.",
      inputSchema: z.object({
        queries: z
          .array(z.string().min(2).max(80))
          .min(1)
          .max(MAX_QUERIES)
          .describe(
            'Title phrases, for example "backend engineer", "platform engineer". Never one generic word.',
          ),
        locations: z
          .array(z.string().min(2).max(60))
          .max(MAX_LOCATIONS)
          .optional()
          .describe(
            'Require the job to be in one of these places (any may match): cities, state names AND abbreviations, "remote". For Washington state: ["Seattle", "Bellevue", "Redmond", "Washington", "WA"]. Leave out when the person did not name a place.',
          ),
      }),
      execute: async ({ queries, locations }) => ({
        hits: await jobs.search(
          queries,
          SEARCH_LIMIT,
          locations?.length ? { locations } : undefined,
        ),
      }),
    }),

    read_job: tool({
      description:
        "Read one job in full: all facts and the complete description. Use only when a plausible fit cannot be judged from the search hit (pay, requirements, location unclear).",
      inputSchema: z.object({
        id: z.string().describe("The id of a job returned by search_jobs."),
      }),
      // The client only needs to know a read happened; the full text goes to the model through toModelOutput
      // so it never travels to the browser or back in the next request.
      execute: async ({ id }) => {
        const job = await jobs.read(id);
        if (!job) return { found: false as const, id };
        descriptions.set(id, job.description ?? "");
        return {
          found: true as const,
          id,
          title: job.title,
          company: job.company,
          chars: job.description?.length ?? 0,
          facts: job.facts,
        };
      },
      toModelOutput: ({ output }) => {
        if (!output.found) return { type: "text", value: `Job ${output.id} is not available.` };
        const description = descriptions.get(output.id);
        const head = `${output.title} at ${output.company}\nFacts: ${JSON.stringify(output.facts)}`;
        return {
          type: "text",
          value:
            description === undefined
              ? `${head}\n(The description is not available in this turn. Call read_job again if you need it.)`
              : `${head}\n\n--- FULL DESCRIPTION ---\n${description || "(This posting has no description.)"}`,
        };
      },
    }),

    show_jobs: tool({
      description:
        "Publish the final ranking to the results panel beside the chat, best fit first. Call it once, when you are done. An empty list means nothing fits.",
      inputSchema: z.object({ matches: z.array(Match).max(MAX_MATCHES) }),
      execute: async ({ matches }) => {
        const seen = new Set<string>();
        let dropped = 0;
        const checked = matches
          .filter((m) => !seen.has(m.id) && seen.add(m.id))
          .map((m) => {
            const evidence = m.evidence.filter((q) =>
              isVerbatim(q, [descriptions.get(m.id), profile]),
            );
            dropped += m.evidence.length - evidence.length;
            return { ...m, evidence };
          });
        return { matches: checked, droppedEvidence: dropped };
      },
    }),
  };
}

export type JobTools = ReturnType<typeof createTools>;
