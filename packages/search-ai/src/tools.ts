import { searchSpecSchema } from "@tallo/contracts";
import { tool } from "ai";
import { z } from "zod";
import type { JobsPort } from "./jobs.ts";

export const SEARCH_LIMIT = 40;
const MAX_NOTES = 12;

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** A quote counts only if it appears word for word (whitespace and case aside) in a source we actually have. */
const isVerbatim = (quote: string, sources: (string | undefined)[]) => {
  const needle = squash(quote);
  return (
    needle.length > 0 &&
    sources.some((source) => source !== undefined && squash(source).includes(needle))
  );
};

const Note = z.object({
  id: z.string().describe("The id of a job returned by search_jobs."),
  why: z
    .string()
    .min(3)
    .max(240)
    .describe(
      "One sentence: why this job is in the list, or what stands out. Only facts from its hit or a description you read.",
    ),
  evidence: z
    .array(z.string())
    .max(2)
    .describe(
      "Exact quotes copied character for character from a description you read or the profile. Empty if you did not read it.",
    ),
});

/**
 * The assistant's two tools. `search_jobs` is the contract with the app: its input is the search the person
 * ends up seeing, run by the database, so the last call of a turn defines the results list. `read_job` is the
 * deep look, used rarely. Created per request: `descriptions` holds the full text read in this turn.
 */
export function createTools({ jobs, profile }: { jobs: JobsPort; profile: string }) {
  const descriptions = new Map<string, string>();

  return {
    search_jobs: tool({
      description:
        "Search the catalog of open job postings (every kind of work and place the sources list). The results list the person sees is this search, run by the database, so put everything they asked for in it; the database does not filter by relevance, so judge the hits yourself. Returns up to 40 compact hits (title, company, location, work mode, pay as the source stated it, posted date, department) for you to read; a null field is unknown.",
      inputSchema: searchSpecSchema,
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
        "Read one job in full: the facts the source stated and the complete description. Use only when a question cannot be answered from the search hit (pay, requirements, location unclear).",
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

    explain_jobs: tool({
      description:
        "Attach a short note to jobs in the results list saying why each is there or what stands out. The list itself is not yours: you can only annotate jobs that exist. Notes with an unknown id are dropped, and quotes that are not word for word in a description you read are removed.",
      inputSchema: z.object({ notes: z.array(Note).min(1).max(MAX_NOTES) }),
      execute: async ({ notes }) => {
        const unique = notes.filter((n, i) => notes.findIndex((m) => m.id === n.id) === i); // first note per job wins
        const visible = new Set((await jobs.lookup(unique.map((n) => n.id))).map((hit) => hit.id));
        const kept = unique
          .filter((n) => visible.has(n.id))
          .map((n) => ({
            ...n,
            evidence: n.evidence.filter((q) => isVerbatim(q, [descriptions.get(n.id), profile])),
          }));
        return { notes: kept, dropped: notes.length - kept.length };
      },
    }),
  };
}

export type JobTools = ReturnType<typeof createTools>;
