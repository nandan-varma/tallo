import { clip } from "@tallo/ai";
import { SEARCH_RESULT_CAP, searchSpecSchema } from "@tallo/contracts";
import { tool } from "ai";
import { z } from "zod";
import type { JobHit, JobRead, JobsPort } from "./jobs.ts";
import { MAX_READS } from "./prompt.ts";

export const SEARCH_LIMIT = 40;
const MAX_NOTES = 12;
/**
 * The most of a description the model reads. About 5k tokens: the start and the end are kept and the cut is
 * marked, so a very long posting cannot make one read cost more than this.
 */
export const READ_MAX_CHARS = 20_000;

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
 * What the model reads of a search: one line per hit, `id | title | company | location | mode | pay | date | dept`.
 * A null field is unknown and is left out, so a line only has the fields the catalog has. The browser never sees
 * this text; it gets the structured hits.
 */
export function hitLines(hits: JobHit[]): string {
  if (hits.length === 0) return "No hits. Try other title phrases, or fewer places.";
  const lines = hits.map((hit) =>
    [
      hit.id,
      hit.title,
      hit.company,
      hit.location,
      hit.workMode,
      hit.pay,
      hit.postedAt,
      hit.department,
      hit.locations > 1 ? `${hit.locations} locations` : null,
    ]
      .filter((field) => field !== null && field !== "")
      .join(" | "),
  );
  return `${hits.length} hits, most relevant first:\n${lines.join("\n")}`;
}

/** Literal inspection of the full cached text; no regex execution and no unbounded output. */
export function passages(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const spans: [number, number][] = [];
  for (const term of terms) {
    let from = 0;
    for (let count = 0; count < 2; count += 1) {
      const at = lower.indexOf(term.toLowerCase(), from);
      if (at < 0) break;
      spans.push([Math.max(0, at - 350), Math.min(text.length, at + term.length + 650)]);
      from = at + term.length;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return (
    clip(
      merged
        .map(
          ([start, end]) =>
            `[Characters ${start}-${end} of ${text.length}]\n${text.slice(start, end)}`,
        )
        .join("\n\n"),
      READ_MAX_CHARS,
    ) ||
    "No literal passages matched. This does not establish absence of a requirement; read the posting."
  );
}

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
    .array(z.string().min(3).max(600))
    .max(2)
    .describe(
      "Exact quotes copied character for character from a description you read or the profile. Empty if you did not read it.",
    ),
});

/** Per-turn candidates, cached full descriptions, and only the passages actually shown to the model. */
export function createTools({
  jobs,
  profile,
  reviewedViews,
}: {
  jobs: JobsPort;
  profile: string;
  reviewedViews: Set<string>;
}) {
  const descriptions = new Map<string, string>();
  const candidates = new Set<string>();
  const reads = new Map<string, Promise<JobRead | null>>();
  const views = new Map<string, { id: string; text: string }>();
  let viewId = 0;

  return {
    search_jobs: tool({
      description:
        "Discover candidates, not recommendations. Matches title phrases, companies and structured locations; descriptions are NOT indexed. Use offset to explore additional pages. For incomplete location metadata, also explore without locations and verify actual geography by reading descriptions before publishing.",
      inputSchema: searchSpecSchema.extend({
        offset: z
          .number()
          .int()
          .min(0)
          .max(SEARCH_RESULT_CAP - 1)
          .default(0),
      }),
      execute: async ({ offset, ...spec }) => {
        const hits = await jobs.search(
          spec,
          Math.min(SEARCH_LIMIT, SEARCH_RESULT_CAP - offset),
          offset,
        );
        for (const hit of hits) candidates.add(hit.id);
        return { hits };
      },
      toModelOutput: ({ output }) => ({ type: "text", value: hitLines(output.hits) }),
    }),

    read_job: tool({
      description:
        "Read a posting's facts and description. Repeated reads are cached. Default: first and last text, with any omitted middle marked. Set start for a contiguous 20,000-character page, or terms to find literal passages anywhere in the full text. Check requirements and geographic restrictions, not just matching snippets. Batch independent calls when useful.",
      inputSchema: z.object({
        id: z.string().describe("The id of a candidate returned by search_jobs."),
        start: z.number().int().min(0).max(10_000_000).optional(),
        terms: z.array(z.string().trim().min(2).max(80)).min(1).max(8).optional(),
      }),
      execute: async ({ id, start, terms }) => {
        if (!reads.has(id)) {
          if (reads.size >= MAX_READS) return { limited: true as const, id };
          // Store before awaiting: parallel calls for one id share one R2 read.
          reads.set(
            id,
            jobs.read(id).catch(() => null),
          );
        }
        const job = await reads.get(id);
        if (!job) return { found: false as const, id };
        const full = job.description ?? "";
        const text = terms
          ? passages(full, terms)
          : start !== undefined
            ? `[Characters ${start}-${Math.min(start + READ_MAX_CHARS, full.length)} of ${full.length}]\n${full.slice(start, start + READ_MAX_CHARS)}`
            : clip(full, READ_MAX_CHARS);
        const key = String(++viewId);
        views.set(key, { id, text });
        // Only shown source text is admissible evidence, not an unseen part of the cached description.
        descriptions.set(id, `${descriptions.get(id) ?? ""}\n${text}`);
        return {
          found: true as const,
          id,
          title: job.title,
          company: job.company,
          chars: full.length,
          facts: job.facts,
          view: key,
          partial: terms !== undefined || start !== undefined || full.length > READ_MAX_CHARS,
          notice: job.descriptionNotice,
        };
      },
      toModelOutput: ({ output }) => {
        if ("limited" in output)
          return {
            type: "text",
            value: `Read limit reached (${MAX_READS} distinct jobs). Publish only reviewed matches, or an empty shortlist.`,
          };
        if (!output.found) return { type: "text", value: `Job ${output.id} is not available.` };
        const text = views.get(output.view)?.text;
        if (text === undefined)
          return {
            type: "text",
            value: `${output.title} at ${output.company}\nDescription view is unavailable in this turn. Call read_job again before reviewing or publishing this posting.`,
          };
        return {
          type: "text",
          value: `${output.title} at ${output.company}\nFacts: ${JSON.stringify(output.facts)}\n--- DESCRIPTION${output.partial ? " (partial view; inspect other sections as needed)" : ""} ---\n${text || output.notice || "(This posting has no description.)"}`,
        };
      },
    }),

    publish_jobs: tool({
      description:
        "Publish the actual recommendations in best-fit order, after investigating candidates. Only jobs discovered and read this turn with an available description can appear. Required mismatches must be left out; unknown explicit constraints are not verified matches. Include an honest fit note and exact description quotes. Use an empty jobs array if nothing qualifies. This replaces the visible shortlist, including when empty.",
      inputSchema: z.object({
        search: searchSpecSchema.describe(
          "The complete requested search for saving: preserve the user’s requested titles, companies and locations, not a broadened exploratory query.",
        ),
        jobs: z.array(Note).max(30),
      }),
      execute: async ({ search, jobs: selected }) => {
        const unique = selected.filter((n, i) => selected.findIndex((m) => m.id === n.id) === i);
        const reviewed = unique.filter((n) => candidates.has(n.id) && reads.has(n.id));
        const available = new Map(
          (await jobs.lookup(reviewed.map((n) => n.id))).map((hit) => [hit.id, hit]),
        );
        const notes = [];
        const hits: JobHit[] = [];
        for (const note of reviewed) {
          const hit = available.get(note.id);
          const read = await reads.get(note.id);
          const description = read?.description;
          if (!hit || !description?.trim()) continue;
          const shown = [...views]
            .filter(([key, view]) => reviewedViews.has(key) && view.id === note.id)
            .map(([, view]) => view.text);
          const evidence = note.evidence.filter(
            (q) => isVerbatim(q, shown) && isVerbatim(q, [description]),
          );
          // Publishing is stricter than legacy annotations: at least one verified job quote is required.
          if (evidence.length === 0) continue;
          hits.push(hit);
          notes.push({ ...note, evidence });
        }
        return { search, hits, notes, dropped: selected.length - hits.length };
      },
      toModelOutput: ({ output }) => ({
        type: "text",
        value: `${output.hits.length} reviewed recommendations published; ${output.dropped} selections rejected (not discovered, unread, unavailable, or no verified description evidence).${output.dropped ? " Correct the rejected selections or explain the gap; never claim they were published." : ""}\n${hitLines(output.hits)}`,
      }),
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
