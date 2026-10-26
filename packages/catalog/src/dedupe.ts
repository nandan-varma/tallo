import { sha256 } from "./hash.ts";

/**
 * Bump when normalization changes, then backfill and run a full dedupe rebuild (keys are
 * recomputed from stored company, title and jd_hash, so no refetching is needed).
 */
export const DEDUPE_VERSION = 1;

/** Trailing legal-entity words that do not distinguish an employer ("Acme, Inc." is "Acme"). */
const LEGAL_SUFFIX = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "plc",
  "gmbh",
  "pllc",
  "lp",
  "llp",
]);

const words = (text: string): string[] =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** Case, punctuation and a trailing legal suffix are not facts about the employer. */
export function normalizeCompany(name: string): string {
  const tokens = words(name);
  while (tokens.length > 1 && LEGAL_SUFFIX.has(tokens[tokens.length - 1] ?? "")) tokens.pop();
  return tokens.join(" ");
}

/** Case and punctuation only: "Product/Event Demonstrator" equals "product / event demonstrator". */
export const normalizeTitle = (title: string): string => words(title).join(" ");

/**
 * One posting listed once per location shares company, title and description. The key groups
 * those rows; `jdHash` is part of it so unrelated jobs with the same title never merge.
 */
export async function dedupeKey(input: {
  company: string;
  title: string;
  jdHash: string;
}): Promise<string> {
  const parts = [
    `v${DEDUPE_VERSION}`,
    normalizeCompany(input.company),
    normalizeTitle(input.title),
    input.jdHash,
  ];
  return sha256(parts.join("\n"));
}
