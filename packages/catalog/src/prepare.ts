import type { JobFacts, MappedJob, SourceConfig } from "@tallo/contracts";
import { boundFacts } from "./bound.ts";
import { dedupeKey } from "./dedupe.ts";
import { gzip, sha256, stableStringify } from "./hash.ts";
import { cleanTitle, excerpt } from "./text.ts";

/**
 * Version of the prepare rules (titles, derived columns). The runner mixes it into each posting's
 * source hash, so bumping it makes the next sync re-prepare every posting, not just changed ones.
 */
export const PREPARE_VERSION = 2;

interface PreparedJob {
  facts: JobFacts;
  /** Gzipped description text, addressed by `facts.jdHash`. */
  jd: Uint8Array;
  /** Fields that did not fit the wire contract and were nulled or cut (see `boundFacts`). */
  notes: string[];
}

const MAX_EXTRAS_BYTES = 4096;

/** A shortened place name would be a different fact; keep the full value in facts.locations. */
const placeName = (value: string | undefined): string | null =>
  value !== undefined && value.length <= 120 ? value : null;

const epoch = (iso: string | undefined): number | null => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 1000) : null;
};

/**
 * Mapped job in, wire facts + JD blob out. Only what the source stated is kept: no value is derived from
 * the text, so an unstated fact stays null and the reader judges from the facts and the description.
 */
export async function prepareJob(
  job: MappedJob,
  source: SourceConfig,
  sourceHash: string,
): Promise<PreparedJob> {
  const primary = job.locations.find((l) => l.primary) ?? job.locations[0];
  const title = cleanTitle(job.title);
  const extras = stableStringify(job.extras).length <= MAX_EXTRAS_BYTES ? job.extras : {};
  const text = new TextEncoder().encode(job.description);

  const columns = {
    postingId: job.postingId,
    title,
    url: job.url ?? null,
    applyUrl: job.applyUrl ?? null,
    locationText: primary ? excerpt(primary.text, 500) : null,
    city: placeName(primary?.city),
    region: placeName(primary?.region),
    countryCode: primary?.countryCode ?? null,
    workMode: job.workMode ?? null,
    department: job.department ?? null,
    team: job.team ?? null,
    employmentType: job.employmentType ?? null,
    requisitionId: job.requisitionId ?? null,
    postedAt: epoch(job.postedAt),
    sourceUpdatedAt: epoch(job.updatedAt),
    expiresAt: epoch(job.expiresAt),
    excerpt: excerpt(job.description),
    jdBytes: text.byteLength,
  };
  const facts = {
    platform: source.platform,
    locations: job.locations,
    compensation: job.compensation,
    experience: job.experience,
    extras,
  };
  const jdHash = await sha256(text);
  const bounded = boundFacts({
    ...columns,
    jdHash,
    dedupeKey: await dedupeKey({ company: source.company, title, jdHash }),
    sourceHash,
    facts,
  });
  return { ...bounded, jd: await gzip(text) };
}
