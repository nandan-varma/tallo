import type { JobFacts } from "@tallo/contracts";

/** Array sizes kept in `facts` (rule 4: the database stays lean). Anything beyond is dropped and reported. */
export const MAX_LOCATIONS = 100;
export const MAX_COMPENSATION = 50;
export const MAX_EXPERIENCE = 50;
/** Serialized `facts` ceiling; past it the arrays shrink further and extras go. */
export const MAX_FACTS_BYTES = 32 * 1024;
const MAX_POSTING_ID = 512;

/** Caps of the wire contract (`jobFactsSchema`) for the columns a source controls. */
const NULLABLE_TEXT = {
  url: 2048,
  applyUrl: 2048,
  locationText: 500,
  city: 120,
  region: 120,
  department: 200,
  team: 200,
  employmentType: 100,
  requisitionId: 200,
} as const;

const clip = (value: string, max: number): string => {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  // Do not end on half a surrogate pair.
  return `${/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
};

export interface Bounded {
  facts: JobFacts;
  /** One line per field that was nulled or cut, for the run's issues. Empty when the posting was in bounds. */
  notes: string[];
}

/**
 * Fit one posting to the wire contract instead of letting one long field fail a whole batch. A stated value
 * that does not fit is set to null (a shortened URL or name would be a different fact); the title, which a
 * posting cannot be without, is cut; the facts arrays are capped. Throws only when the posting id itself does
 * not fit, because it is the posting's identity. Used by `prepareJob` (runner and Worker) and `applyJobs`.
 */
export function boundFacts(input: JobFacts): Bounded {
  if (input.postingId.length === 0 || input.postingId.length > MAX_POSTING_ID)
    throw new Error(`postingId length ${input.postingId.length} is outside 1..${MAX_POSTING_ID}`);
  const notes: string[] = [];
  const facts: JobFacts = { ...input };

  for (const [field, max] of Object.entries(NULLABLE_TEXT) as [
    keyof typeof NULLABLE_TEXT,
    number,
  ][]) {
    const value = facts[field];
    if (value !== null && value.length > max) {
      notes.push(`${field} is ${value.length} characters (max ${max}); stored as null`);
      facts[field] = null;
    }
  }
  if (facts.title.length > 500) {
    notes.push(`title is ${facts.title.length} characters (max 500); cut`);
    facts.title = clip(facts.title, 500);
  }
  if (facts.excerpt.length > 400) facts.excerpt = clip(facts.excerpt, 400);
  if (facts.countryCode !== null && facts.countryCode.length !== 2) {
    notes.push("countryCode is not two letters; stored as null");
    facts.countryCode = null;
  }

  const rich = { ...facts.facts };
  const cap = (key: string, max: number) => {
    const list = rich[key];
    if (Array.isArray(list) && list.length > max) {
      notes.push(`facts.${key} has ${list.length} entries (max ${max}); first ${max} kept`);
      rich[key] = list.slice(0, max);
    }
  };
  cap("locations", MAX_LOCATIONS);
  cap("compensation", MAX_COMPENSATION);
  cap("experience", MAX_EXPERIENCE);
  if (JSON.stringify(rich).length > MAX_FACTS_BYTES) {
    notes.push(`facts exceed ${MAX_FACTS_BYTES} bytes; arrays cut to 10 entries, extras dropped`);
    for (const key of ["locations", "compensation", "experience"])
      if (Array.isArray(rich[key])) rich[key] = (rich[key] as unknown[]).slice(0, 10);
    rich.extras = {};
  }
  facts.facts = rich;
  return { facts, notes };
}
