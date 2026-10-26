import type { Item, SearchResult, Trace } from "@tallo/search-ai";

/** Same-origin proxy route; the access-key cookie gates it like every other page. */
export const ASK_ENDPOINT = "/api/ai/ask";
/** Browser-side give-up point. Generous: a deep search reads descriptions and can take minutes. */
export const ASK_TIMEOUT_MS = 180_000;
export const PROFILE_STORAGE_KEY = "tallo.askProfile";
export const MAX_QUERY_CHARS = 500;
export const MAX_PROFILE_CHARS = 20_000;

export type AskBody = { query: string; profile?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** The request body the island sends. The profile is omitted entirely when blank. */
export function buildAskBody(query: string, profile: string): AskBody {
  const body: AskBody = { query: query.trim() };
  const trimmed = profile.trim();
  if (trimmed) body.profile = trimmed;
  return body;
}

/** Server-side guard for the proxy: the browser is not trusted to send a well-formed body. */
export function parseAskBody(value: unknown): AskBody | null {
  if (!isRecord(value) || typeof value.query !== "string") return null;
  const query = value.query.trim();
  if (!query || query.length > MAX_QUERY_CHARS) return null;
  if (value.profile === undefined) return { query };
  if (typeof value.profile !== "string" || value.profile.length > MAX_PROFILE_CHARS) return null;
  return buildAskBody(query, value.profile);
}

/**
 * Stored profile text. Stored data can be edited or stale, so anything that is not a string is
 * dropped and the length is capped to what the request accepts.
 */
export function readStoredProfile(raw: string | null): string {
  return raw === null ? "" : raw.slice(0, MAX_PROFILE_CHARS);
}

const isItem = (value: unknown): value is Item => {
  if (!isRecord(value)) return false;
  return (
    typeof value.rank === "number" &&
    Number.isFinite(value.rank) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.company === "string" &&
    isStringArray(value.locations) &&
    (value.verdict === "strong" || value.verdict === "maybe") &&
    (value.fit === null || (typeof value.fit === "number" && Number.isFinite(value.fit))) &&
    typeof value.reason === "string" &&
    isStringArray(value.evidence) &&
    isStringArray(value.unknowns)
  );
};

/**
 * Validates the `{ answer, trace }` contract. Items are all-or-nothing: a partly valid answer is
 * rejected rather than shown with missing fields. The trace is only checked to be an object;
 * each display row is read defensively in `traceSections`.
 */
export function parseAskResult(value: unknown): SearchResult | null {
  if (!isRecord(value) || !isRecord(value.answer) || !isRecord(value.trace)) return null;
  const { answer, trace } = value;
  if (typeof answer.query !== "string" || !Array.isArray(answer.items)) return null;
  if (!answer.items.every(isItem)) return null;
  return {
    answer: { query: answer.query, items: answer.items },
    trace: trace as unknown as Trace,
  };
}

/** Ranked best fit first. The engine assigns `rank`; ties keep the order they arrived in. */
export const sortByRank = (items: Item[]): Item[] => [...items].sort((a, b) => a.rank - b.rank);

/** Links to the existing job detail page. Only numeric ids exist there. */
export const itemHref = (id: string): string | null => (/^\d+$/.test(id) ? `/jobs/${id}` : null);

/** Reads `error` or `message` from a JSON error body. Plain text or other shapes yield null. */
export function errorDetail(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    const detail = value.error ?? value.message;
    return typeof detail === "string" && detail.trim() ? detail.trim() : null;
  } catch {
    return null;
  }
}

/** The user-facing message for a failed request. Status null means the request never got a response. */
export function askFailure(status: number | null, detail: string | null = null): string {
  switch (status) {
    case null:
      return "Could not reach the search service. Check your connection and try again.";
    case 400:
    case 422:
      return (
        detail ?? "The search request was rejected. Shorten the query or profile and try again."
      );
    case 401:
    case 403:
      return "Not authorized. Reload the page with your access key.";
    case 404:
      return "AI search is not available on this server yet.";
    case 408:
    case 504:
      return "The search timed out before it finished. Try a narrower query, or try again.";
    case 502:
      return "The search service could not be reached from the web server. Try again shortly.";
    case 503:
      return "AI search is not configured on the server (no model or key set).";
    default:
      return detail ?? `The search failed on the server (HTTP ${status}).`;
  }
}

const UNEXPECTED_ANSWER = "The server returned an answer in an unexpected shape.";

export type AskErrorKind = "failed" | "timeout" | "cancelled";

export class AskError extends Error {
  readonly kind: AskErrorKind;
  constructor(message: string, kind: AskErrorKind) {
    super(message);
    this.name = "AskError";
    this.kind = kind;
  }
}

/**
 * Posts one search and resolves to a validated result. Cancelling (via `signal`) and the
 * timeout both abort the request and surface as distinct AskError kinds.
 */
export async function runAsk(
  body: AskBody,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    fetcher?: typeof fetch;
  } = {},
): Promise<SearchResult> {
  const controller = new AbortController();
  let timedOut = false;
  const onCancel = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", onCancel);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? ASK_TIMEOUT_MS);

  try {
    const response = await (options.fetcher ?? fetch)(ASK_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AskError(askFailure(response.status, errorDetail(text)), "failed");
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new AskError(UNEXPECTED_ANSWER, "failed");
    }
    const result = parseAskResult(value);
    if (!result) throw new AskError(UNEXPECTED_ANSWER, "failed");
    return result;
  } catch (error) {
    if (error instanceof AskError) throw error;
    if (timedOut) throw new AskError(askFailure(504), "timeout");
    if (options.signal?.aborted) throw new AskError("Search cancelled.", "cancelled");
    throw new AskError(askFailure(null), "failed");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
  }
}

/** Seconds as `42s`, or `2m 05s` once past a minute. */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export type TraceRow = { label: string; value: string };
export type TraceSection = { title: string; rows: TraceRow[] };

const count = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : null;

const rows = (...pairs: [string, unknown][]): TraceRow[] =>
  pairs.flatMap(([label, raw]) => {
    const value = count(raw);
    return value === null ? [] : [{ label, value }];
  });

/**
 * Sections for the Trace panel. Each value is read defensively and any absent or non-numeric
 * field is dropped, so the panel never shows a made-up zero. `elapsedSeconds` is measured in the
 * browser (the engine trace has no duration) and is labelled as such.
 */
export function traceSections(trace: Trace, elapsedSeconds?: number): TraceSection[] {
  const t = trace as unknown as Record<string, unknown>;
  const section = (title: string, sectionRows: TraceRow[]) =>
    sectionRows.length > 0 ? [{ title, rows: sectionRows }] : [];
  const pick = (source: Record<string, unknown>, key: string): Record<string, unknown> => {
    const value = source[key];
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  };
  const understand = pick(t, "understand");
  const recall = pick(t, "recall");
  const triage = pick(t, "triage");
  const deep = pick(t, "deep");
  const answer = pick(t, "answer");
  const tokens = pick(t, "tokens");
  const fast = pick(tokens, "fast");
  const smart = pick(tokens, "smart");

  return [
    ...section(
      "Understand",
      rows(
        ["Titles", Array.isArray(understand.titles) ? understand.titles.length : undefined],
        ["Queries", Array.isArray(understand.queries) ? understand.queries.length : undefined],
      ),
    ),
    ...section("Recall", rows(["Queries", recall.queries], ["Candidates", recall.candidates])),
    ...section(
      "Triage",
      rows(
        ["Batches", triage.batches],
        ["Strong", triage.strong],
        ["Maybe", triage.maybe],
        ["No", triage.no],
        ["Defaulted to maybe", triage.defaulted],
      ),
    ),
    ...section(
      "Deep reads",
      rows(
        ["Reads", deep.reads],
        ["Description chars read", deep.descriptionChars],
        ["Parts", deep.chunks],
        ["Empty descriptions", deep.emptyDescriptions],
        ["Quotes dropped", deep.droppedEvidence],
      ),
    ),
    ...section("Answer", rows(["Items", answer.items])),
    ...section(
      "Tokens",
      rows(
        ["Fast input", fast.input],
        ["Fast output", fast.output],
        ["Smart input", smart.input],
        ["Smart output", smart.output],
      ),
    ),
    ...section("Model retries", rows(["Retries", t.retries])),
    ...section(
      "Timing",
      rows([
        "Round trip, measured in browser (s)",
        elapsedSeconds === undefined ? undefined : Math.round(elapsedSeconds),
      ]),
    ),
  ];
}
