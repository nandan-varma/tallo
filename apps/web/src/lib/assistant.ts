import type { SearchSpec } from "@tallo/contracts";
import type { JobAgentMessage, JobHit } from "@tallo/search-ai";

/**
 * What the UI shows beside the chat is derived from the conversation itself, so there is one source of truth:
 * only published, reviewed jobs drive chat recommendations. Search specs remain available for saving broad
 * discovery searches. All job records and evidence come from validated server tool results.
 */
type Part = JobAgentMessage["parts"][number];

const assistantParts = (messages: JobAgentMessage[]) =>
  messages.filter((m) => m.role === "assistant").flatMap((m) => m.parts);

/** The search the results list runs: the last `search_jobs` call that finished, anywhere in the conversation. */
export function currentSearch(messages: JobAgentMessage[]): SearchSpec | null {
  for (const part of assistantParts(messages).reverse()) {
    if (
      part.type === "tool-publish_jobs" &&
      part.state === "output-available" &&
      part.output.search
    ) {
      return part.output.search;
    }
    if (part.type === "tool-search_jobs" && part.state === "output-available") {
      const { queries, companies, locations } = part.input;
      return {
        queries,
        ...(companies?.length ? { companies } : {}),
        ...(locations?.length ? { locations } : {}),
      };
    }
  }
  return null;
}

/** Only the latest user turn can publish recommendations. Raw search hits are never a fallback. */
export function currentResults(messages: JobAgentMessage[]): JobHit[] | null {
  const start = messages.findLastIndex((message) => message.role === "user");
  for (const part of assistantParts(messages.slice(Math.max(0, start))).reverse()) {
    if (part.type === "tool-publish_jobs" && part.state === "output-available") {
      return part.output.hits;
    }
  }
  return null;
}

export type Note = { id: string; why: string; evidence: string[] };

/** The assistant's notes by job id. Later notes replace earlier ones for the same job. */
export function notesById(messages: JobAgentMessage[]): Map<string, Note> {
  const notes = new Map<string, Note>();
  for (const part of assistantParts(messages)) {
    if (
      (part.type === "tool-explain_jobs" || part.type === "tool-publish_jobs") &&
      part.state === "output-available"
    ) {
      for (const note of part.output.notes) notes.set(note.id, note);
    }
  }
  return notes;
}

/** Every job any search returned: only used to name the jobs the assistant reads. */
export function collectHits(messages: JobAgentMessage[]): Map<string, JobHit> {
  const hits = new Map<string, JobHit>();
  for (const part of assistantParts(messages)) {
    if (
      (part.type === "tool-search_jobs" || part.type === "tool-publish_jobs") &&
      part.state === "output-available"
    ) {
      for (const hit of part.output.hits) hits.set(hit.id, hit);
    }
  }
  return hits;
}

export type Activity = {
  key: string;
  tool: "search" | "read" | "note";
  state: "running" | "done" | "error";
  label: string;
  /** Secondary text: the phrases searched, or the size of what was read. */
  detail?: string;
};

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const stateOf = (s: string): Activity["state"] =>
  s === "output-error" ? "error" : s === "output-available" ? "done" : "running";

/** One line per tool call in a message, in the order the model made them. */
export function activitiesOf(message: JobAgentMessage, hits: Map<string, JobHit>): Activity[] {
  const out: Activity[] = [];
  for (const part of message.parts as Part[]) {
    const key = "toolCallId" in part ? part.toolCallId : "";
    if (part.type === "tool-search_jobs") {
      const queries = part.input?.queries?.filter((q): q is string => typeof q === "string") ?? [];
      const places = part.input?.locations?.filter((l): l is string => typeof l === "string") ?? [];
      out.push({
        key,
        tool: "search",
        state: stateOf(part.state),
        label:
          part.state === "output-available"
            ? `Found ${count(part.output.hits.length, "role")}`
            : queries.length > 0
              ? `Searching ${count(queries.length, "title phrase")}`
              : "Searching",
        detail:
          [queries.join(" · "), places.length ? `in ${places.join(", ")}` : ""]
            .filter(Boolean)
            .join(" ") || undefined,
      });
    } else if (part.type === "tool-read_job") {
      const id = part.input?.id;
      const hit = id ? hits.get(id) : undefined;
      const name = hit ? `${hit.title} · ${hit.company}` : "a posting";
      out.push({
        key,
        tool: "read",
        state: stateOf(part.state),
        label: part.state === "output-available" ? `Read ${name}` : `Reading ${name}`,
        detail:
          part.state === "output-available" && part.output.found
            ? `${count(part.output.chars, "character")} in source${part.input.terms?.length ? ", matching passages" : part.input.start !== undefined ? ", reading a section" : ", reading description"}`
            : undefined,
      });
    } else if (part.type === "tool-publish_jobs") {
      const n = part.state === "output-available" ? part.output.hits.length : undefined;
      out.push({
        key,
        tool: "note",
        state: stateOf(part.state),
        label:
          n === undefined ? "Selecting reviewed roles" : `Selected ${count(n, "reviewed role")}`,
      });
    } else if (part.type === "tool-explain_jobs") {
      const n = part.state === "output-available" ? part.output.notes.length : undefined;
      out.push({
        key,
        tool: "note",
        state: stateOf(part.state),
        label: n === undefined ? "Adding notes" : `Added ${count(n, "note")}`,
      });
    }
  }
  return out;
}

/** Plain text of a message, one paragraph per text part (the model writes a new part after each tool call). */
export const textOf = (message: JobAgentMessage): string =>
  message.parts
    .flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text.trim()] : []))
    .join("\n\n");

/**
 * The text parts of an assistant message, flagged when they come before its last tool call: that is narration
 * ("let me search"), shown quietly, while the text after the last tool call is the answer.
 */
export function textBlocks(message: JobAgentMessage): { text: string; narration: boolean }[] {
  const lastTool = message.parts.findLastIndex((p) => p.type.startsWith("tool-"));
  return message.parts.flatMap((p, i) =>
    p.type === "text" && p.text.trim() ? [{ text: p.text.trim(), narration: i < lastTool }] : [],
  );
}

/** The last user message, for the chat header. */
export const lastUserText = (messages: JobAgentMessage[]): string => {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last ? textOf(last) : "";
};

/** "2026-10-23" as "3d ago" / "2mo ago". */
export function postedLabel(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return null;
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
