import { PREPARE_VERSION, prepareJob, sha256, stableStringify } from "@tallo/catalog";
import type { JobFacts, RawPosting, SourceConfig } from "@tallo/contracts";
import { platformFor } from "@tallo/platforms";

/** One posting after map and prepare: wire facts, the gzipped description, and its raw ndjson line. */
export interface PreparedPosting {
  facts: JobFacts;
  jd: Uint8Array;
  /** Fields nulled or cut to fit the wire contract; the engine reports them as an issue. */
  notes: string[];
  /** `JSON.stringify(posting)` plus a newline: one line of the run's raw pack. */
  line: string;
}

/**
 * The CPU-heavy steps of a run, as a hook. The in-thread default is what the Worker and the tests use;
 * the Mac runner swaps in a `worker_threads` pool so network I/O never waits on hashing, HTML to text
 * and gzip. Arguments and results are plain data (structured-cloneable), and both sides run the same
 * pure code from `@tallo/catalog` and `@tallo/platforms`.
 */
export interface Cpu {
  /** Source hash of each listing, in order: sha256 of the stable fingerprint plus the versions. */
  hashes(source: SourceConfig, listings: unknown[]): Promise<string[]>;
  /** Map a posting (with its detail) and prepare it. Throws when the posting has no title. */
  prepare(source: SourceConfig, posting: RawPosting, hash: string): Promise<PreparedPosting>;
}

export const inThreadCpu: Cpu = {
  async hashes(source, listings) {
    const platform = platformFor(source);
    // The prepare version is part of the hash so a catalog rule change re-prepares unchanged postings.
    const version = { platform: platform.version, prepare: PREPARE_VERSION };
    return Promise.all(
      listings.map((listing) => {
        const stable = platform.fingerprint?.(listing as RawPosting["listing"]) ?? listing;
        return sha256(stableStringify({ stable, ...version }));
      }),
    );
  },
  async prepare(source, posting, hash) {
    const mapped = platformFor(source).map(posting, source);
    if (!mapped.title) throw new Error("Posting has no title");
    const { facts, jd, notes } = await prepareJob(mapped, source, hash);
    return { facts, jd, notes, line: `${JSON.stringify(posting)}\n` };
  },
};
