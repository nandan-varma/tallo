/** 53-bit string hash (cyrb53): sync, deterministic, no dependency. Only names a slug, never secures anything. */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** A letter or digit that is not Latin script (Common and Inherited characters such as digits and marks are fine). */
const LATIN_OR_NEUTRAL = /[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const hasNonLatin = (name: string) => LETTER_OR_DIGIT.test(name.replace(LATIN_OR_NEUTRAL, ""));
const NOT_WORD = /[^\p{L}\p{N}\p{M}]+/gu;

/**
 * The one company slug, used by ingest and the scheduler.
 *
 * - A name in Latin script keeps the original rule (lowercase, runs of non a-z0-9 become "-"), so every slug
 *   already stored is unchanged. "Grüns" stays "gr-ns": that is what the catalog holds.
 * - A name with letters or digits of another script keeps them ("株式会社 テスト" becomes "株式会社-テスト"), so
 *   such companies no longer collapse into one empty slug.
 * - A name that still yields nothing ("®") gets "c-" plus a hash of the name: stable, never empty.
 */
export function slug(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (ascii && !hasNonLatin(name)) return ascii;
  const unicode = name.normalize("NFKC").toLowerCase().replace(NOT_WORD, "-").replace(/^-|-$/g, "");
  return unicode || `c-${hash53(name).toString(16).padStart(14, "0")}`;
}
