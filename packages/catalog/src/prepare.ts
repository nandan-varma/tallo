import type { JobFacts, MappedJob, SourceConfig } from "@tallo/contracts";
import { dedupeKey } from "./dedupe.ts";
import { gzip, sha256, stableStringify } from "./hash.ts";
import { excerpt } from "./text.ts";

interface PreparedJob {
  facts: JobFacts;
  /** Gzipped description text, addressed by `facts.jdHash`. */
  jd: Uint8Array;
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
 * the text, so an unstated fact stays null and the assistant judges from the facts and the description.
 */
export async function prepareJob(
  job: MappedJob,
  source: SourceConfig,
  sourceHash: string,
): Promise<PreparedJob> {
  const primary = job.locations.find((l) => l.primary) ?? job.locations[0];
  const extras = stableStringify(job.extras).length <= MAX_EXTRAS_BYTES ? job.extras : {};
  const text = new TextEncoder().encode(job.description);

  const columns = {
    postingId: job.postingId,
    title: job.title,
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
  return {
    facts: {
      ...columns,
      jdHash,
      dedupeKey: await dedupeKey({ company: source.company, title: job.title, jdHash }),
      sourceHash,
      facts,
    },
    jd: await gzip(text),
  };
}
