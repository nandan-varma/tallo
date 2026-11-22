import type {
  CollectContext,
  Issue,
  Json,
  MappedJob,
  RawPosting,
  SourceConfig,
} from "@tallo/contracts";
import { isObject } from "@tallo/contracts";
import { createHttp } from "@tallo/http";
import { platformFor } from "@tallo/platforms";

/** Wraps JSON so every property read is recorded; unread keys are what a mapper ignores. */
function track(value: Json | undefined, path: string, reads: Set<string>): Json | undefined {
  if (value === null || typeof value !== "object") return value;
  return new Proxy(value, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !Array.isArray(target))
        reads.add(`${path}.${prop}`.replace(/^\./, ""));
      const next = Reflect.get(target, prop, receiver) as Json | undefined;
      const segment =
        Array.isArray(target) && /^\d+$/.test(String(prop)) ? "[]" : `.${String(prop)}`;
      return typeof prop === "string"
        ? track(next, `${path}${segment}`.replace(/^\./, ""), reads)
        : next;
    },
  }) as Json;
}

function leafPaths(value: Json | undefined, path = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) leafPaths(v, `${path}[]`, out);
  else if (isObject(value))
    for (const [k, v] of Object.entries(value)) leafPaths(v, path ? `${path}.${k}` : k, out);
  else if (path) out.add(path);
  return out;
}

export interface Verification {
  source: string;
  listed: number;
  complete: boolean;
  sampled: number;
  issues: Issue[];
  warnings: string[];
  presence: Record<string, string>;
  /** Source fields no part of `map` ever read (they remain in raw evidence). */
  unmapped: string[];
  sample: MappedJob | undefined;
}

const FIELDS = [
  "url",
  "applyUrl",
  "workMode",
  "department",
  "team",
  "employmentType",
  "requisitionId",
  "postedAt",
  "updatedAt",
  "expiresAt",
] as const;

/** Dry run: list, fetch details for a sample, map, and report quality. Writes nothing. */
export async function verifySource(
  source: SourceConfig,
  sampleSize = 5,
  fetchImpl?: typeof fetch,
): Promise<Verification> {
  const platform = platformFor(source);
  const issues: Issue[] = [];
  const ctx: CollectContext = {
    http: createHttp({
      allowedHosts: platform.hosts,
      perHostConcurrency: 4,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }),
    maxPostings: sampleSize,
    record: (i) => void issues.push(i),
  };
  const listed: RawPosting[] = [];
  let complete = false;
  const gen = platform.list(source, ctx);
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      complete = next.value.complete;
      break;
    }
    listed.push(next.value);
    if (listed.length >= sampleSize) {
      await gen.return({ complete: false, emptyIsAuthoritative: false });
      break;
    }
  }

  const reads = new Set<string>();
  const present = new Set<string>();
  const unread = new Set<string>();
  const mapped: MappedJob[] = [];
  const warnings: string[] = [];
  for (const posting of listed) {
    const full: RawPosting = platform.detail
      ? { ...posting, detail: await platform.detail(source, posting, ctx) }
      : posting;
    const seen = new Set<string>();
    const job = platform.map(
      {
        ...full,
        listing: track(full.listing, "listing", seen)!,
        ...(full.detail === undefined ? {} : { detail: track(full.detail, "detail", seen) }),
      },
      source,
    );
    mapped.push(job);
    for (const k of seen) reads.add(k);
    for (const p of leafPaths(full.listing, "listing")) unread.add(p);
    if (full.detail !== undefined) for (const p of leafPaths(full.detail, "detail")) unread.add(p);
    if (!job.title) warnings.push(`${posting.id}: empty title`);
    if (job.description.length < 80)
      warnings.push(`${posting.id}: description is ${job.description.length} chars`);
    if (job.locations.length === 0) warnings.push(`${posting.id}: no locations`);
    if (!job.url) warnings.push(`${posting.id}: no url`);
    if (job.compensation.length) present.add("compensation");
    if (job.experience.length) present.add("experience");
    for (const f of FIELDS) if (job[f] !== undefined) present.add(f);
  }
  const presence = Object.fromEntries(
    ["compensation", "experience", ...FIELDS].map((f) => [
      f,
      present.has(f) ? "present" : "absent",
    ]),
  );
  // Listing and detail overlap (the detail repeats listing fields), so compare without the prefix.
  const bare = (p: string) => p.replace(/^(listing|detail)\.?/, "").replace(/\[\]/g, "");
  const readPaths = [...reads].map(bare);
  // A path is mapped if it, or a descendant, was read: reading `a.b` means `a` was traversed.
  const unmapped = [...unread]
    .filter((p) => !readPaths.some((r) => r === bare(p) || bare(p).startsWith(`${r}.`)))
    .sort()
    .slice(0, 80);
  return {
    source: source.id,
    listed: listed.length,
    complete,
    sampled: mapped.length,
    issues,
    warnings,
    presence,
    unmapped,
    sample: mapped[0],
  };
}
