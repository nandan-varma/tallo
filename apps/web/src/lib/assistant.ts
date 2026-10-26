import type { JobAgentMessage, JobHit } from "@tallo/search-ai";

/**
 * Everything the UI shows beside the chat is derived from the conversation itself: the hits come from
 * `search_jobs` results and the ranking from `show_jobs`. No second source of truth, nothing to sync.
 */
type Part = JobAgentMessage["parts"][number];

export type RankedMatch = {
  id: string;
  verdict?: "strong" | "maybe";
  fit?: number | null;
  reason?: string;
  evidence: string[];
  unknowns: string[];
  /** What search_jobs returned for this id; absent if the model named an id it never searched. */
  hit?: JobHit;
};

export type Ranking = {
  /** none: no ranking yet. ranking: show_jobs is streaming. done: show_jobs finished. */
  state: "none" | "ranking" | "done";
  matches: RankedMatch[];
};

const assistantParts = (messages: JobAgentMessage[]) =>
  messages.filter((m) => m.role === "assistant").flatMap((m) => m.parts);

/** Every job any search returned in this conversation. Later searches win for the same id. */
export function collectHits(messages: JobAgentMessage[]): Map<string, JobHit> {
  const hits = new Map<string, JobHit>();
  for (const part of assistantParts(messages)) {
    if (part.type === "tool-search_jobs" && part.state === "output-available") {
      for (const hit of part.output.hits) hits.set(hit.id, hit);
    }
  }
  return hits;
}

/** The hits of the latest search, in the order the catalog returned them. */
export function latestSearch(messages: JobAgentMessage[]): JobHit[] {
  for (const part of assistantParts(messages).reverse()) {
    if (part.type === "tool-search_jobs" && part.state === "output-available") {
      return part.output.hits;
    }
  }
  return [];
}

/**
 * The ranking to show: the newest show_jobs call. While it streams, its partial input is shown so cards
 * appear as the model writes them; once it finishes, the server-checked output replaces it (invented
 * evidence quotes are gone from the output).
 */
export function latestRanking(messages: JobAgentMessage[], hits: Map<string, JobHit>): Ranking {
  for (const part of assistantParts(messages).reverse()) {
    if (part.type !== "tool-show_jobs") continue;
    if (part.state === "output-available") {
      return { state: "done", matches: part.output.matches.map((m) => ranked(m, hits)) };
    }
    if (part.state === "input-streaming" || part.state === "input-available") {
      const partial = part.input?.matches ?? [];
      return {
        state: "ranking",
        // An id is still arriving token by token until it names a job the search returned.
        matches: partial.flatMap((m) => (m?.id && hits.has(m.id) ? [ranked(m, hits)] : [])),
      };
    }
    // output-error: fall through to an older ranking, if any.
  }
  return { state: "none", matches: [] };
}

function ranked(
  m: {
    id?: string;
    verdict?: "strong" | "maybe";
    fit?: number | null;
    reason?: string;
    evidence?: (string | undefined)[];
    unknowns?: (string | undefined)[];
  },
  hits: Map<string, JobHit>,
): RankedMatch {
  const id = m.id ?? "";
  return {
    id,
    verdict: m.verdict,
    fit: m.fit,
    reason: m.reason,
    evidence: (m.evidence ?? []).filter((e): e is string => typeof e === "string"),
    unknowns: (m.unknowns ?? []).filter((e): e is string => typeof e === "string"),
    hit: hits.get(id),
  };
}

export type Activity = {
  key: string;
  tool: "search" | "read" | "rank";
  state: "running" | "done" | "error";
  label: string;
  /** Secondary text: the phrases searched, or the size of what was read. */
  detail?: string;
};

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** One line per tool call in a message, in the order the model made them. */
export function activitiesOf(message: JobAgentMessage, hits: Map<string, JobHit>): Activity[] {
  const out: Activity[] = [];
  for (const part of message.parts as Part[]) {
    const key = "toolCallId" in part ? part.toolCallId : "";
    const state = (s: string) =>
      s === "output-error" ? "error" : s === "output-available" ? "done" : "running";
    if (part.type === "tool-search_jobs") {
      const queries = part.input?.queries?.filter((q): q is string => typeof q === "string") ?? [];
      out.push({
        key,
        tool: "search",
        state: state(part.state),
        label:
          part.state === "output-available"
            ? `Found ${count(part.output.hits.length, "role")}`
            : queries.length > 0
              ? `Searching ${count(queries.length, "title phrase")}`
              : "Searching",
        detail: queries.join(" · ") || undefined,
      });
    } else if (part.type === "tool-read_job") {
      const id = part.input?.id;
      const hit = id ? hits.get(id) : undefined;
      const name = hit ? `${hit.title} · ${hit.company}` : "a posting";
      out.push({
        key,
        tool: "read",
        state: state(part.state),
        label: part.state === "output-available" ? `Read ${name}` : `Reading ${name}`,
        detail:
          part.state === "output-available" && part.output.found
            ? `${count(part.output.chars, "character")}, in full`
            : undefined,
      });
    } else if (part.type === "tool-show_jobs") {
      const n = part.state === "output-available" ? part.output.matches.length : undefined;
      out.push({
        key,
        tool: "rank",
        state: state(part.state),
        label:
          n === undefined
            ? "Ranking matches"
            : n === 0
              ? "Nothing fits well"
              : `Ranked ${count(n, "match", "matches")}`,
      });
    }
  }
  return out;
}

/** Plain text of a message: what the person reads, tool calls excluded. */
export const textOf = (message: JobAgentMessage): string =>
  message.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("")
    .trim();

/** The last user message, for the "regenerate" and empty-result hints. */
export const lastUserText = (messages: JobAgentMessage[]): string =>
  textOf([...messages].reverse().find((m) => m.role === "user") ?? ({ parts: [] } as never));

/** "USD 150000-180000 per year" (the API's pay text) as "$150K – $180K / yr". Anything else passes through. */
export function payLabel(pay: string | null): string | null {
  if (!pay) return null;
  const m = /^(?:([A-Z]{3}) )?(\d+)-(\d+) per year$/.exec(pay);
  if (!m) return pay;
  const [, currency, low, high] = m;
  const fmt = (n: string) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(Number(n));
  return low === high
    ? `${fmt(low as string)} / yr`
    : `${fmt(low as string)} – ${fmt(high as string)} / yr`;
}

/** "2026-10-23" as "3d ago" / "2mo ago". */
export function postedLabel(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return null;
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export type Segment = { text: string; quote?: number };

/**
 * Splits text around the evidence quotes so they can be marked. A quote is matched as written, with any
 * run of whitespace allowed to differ, and the first occurrence wins. Quotes not found are skipped.
 */
export function markQuotes(text: string, quotes: string[]): Segment[] {
  const found: { start: number; end: number; quote: number }[] = [];
  quotes.forEach((quote, quoteIndex) => {
    const words = quote.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return;
    const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const m = new RegExp(pattern, "i").exec(text);
    if (m) found.push({ start: m.index, end: m.index + m[0].length, quote: quoteIndex });
  });
  found.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const f of found) {
    if (f.start < cursor) continue; // overlaps an earlier quote
    if (f.start > cursor) segments.push({ text: text.slice(cursor, f.start) });
    segments.push({ text: text.slice(f.start, f.end), quote: f.quote });
    cursor = f.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
