import type { LanguageModel } from "ai";

export type FactValue = string | number | boolean | null | string[];
export type Facts = Record<string, FactValue>;

// A canonical open job as the host sees it. Missing facts are null or absent: they stay unknown.
export type Candidate = {
  id: string;
  title: string;
  company: string;
  locations: string[];
  workMode?: string | null;
  pay?: string | null;
  postedAt?: string | null;
  facts?: Facts;
};

// Implemented by the host (API Worker over D1, or the runner over REST). The engine never imports a database.
export interface JobsPort {
  // Several FTS query variants; the host merges them. Returns at most `limit` canonical open jobs.
  recall(queries: string[], limit: number): Promise<Candidate[]>;
  facts(ids: string[]): Promise<Map<string, Facts>>;
  // FULL description text, never truncated. null when the job has no stored description.
  description(id: string): Promise<string | null>;
}

export type Models = {
  fast: LanguageModel;
  smart: LanguageModel;
};

export type SearchOptions = {
  recallLimit?: number; // default 300
  answerLimit?: number; // default 10
  deepReads?: number; // default 10: cap on jobs whose description is read
  triageBatchSize?: number; // default 100
  descriptionChunkChars?: number; // default 24000: size of one consecutive part when a description is oversized
  maxDescriptionParts?: number; // default 8: above this many parts the search throws; it never truncates
};

export type SearchInput = {
  query: string;
  profile: string; // markdown
  models: Models;
  jobs: JobsPort;
  options?: SearchOptions;
};

export type Verdict = "strong" | "maybe" | "no";

export type Item = {
  rank: number;
  id: string;
  title: string;
  company: string;
  locations: string[];
  verdict: "strong" | "maybe";
  fit: number | null; // 0-100, only for jobs that were deep-read
  reason: string;
  evidence: string[]; // verbatim quotes from the description or profile
  unknowns: string[];
};

export type Answer = {
  query: string;
  items: Item[];
};

export type Tokens = { input: number; output: number };

export type Trace = {
  understand: { titles: string[]; queries: string[] };
  recall: { queries: number; candidates: number };
  triage: {
    batches: number;
    strong: number;
    maybe: number;
    no: number;
    defaulted: number; // candidates the model did not decide; treated as maybe
    decisions: { id: string; verdict: Verdict }[];
  };
  deep: {
    reads: number;
    descriptionChars: number;
    chunks: number;
    emptyDescriptions: number;
    droppedEvidence: number; // quotes that were not found verbatim and were removed
    scored: { id: string; fit: number }[];
  };
  answer: { items: number };
  tokens: { fast: Tokens; smart: Tokens };
  retries: number; // model calls retried once after empty content
};

export type SearchResult = {
  answer: Answer;
  trace: Trace;
};
