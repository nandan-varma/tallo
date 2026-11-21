import { hostAllowed } from "@tallo/http";
import { platforms } from "@tallo/platforms";

/**
 * How hard to lean on one platform's hosts. Public JSON boards tolerate many parallel reads; the
 * tenant-based platforms (Workday, Oracle Cloud) get a start gap per host, enforced globally by the
 * Worker's per-host gate, and little parallelism.
 */
export interface HostPolicy {
  /** In-flight requests per host within one invocation. */
  concurrency: number;
  /** Minimum gap between request starts per host, across all invocations (0: none). */
  gapMs: number;
}

const FAST: HostPolicy = { concurrency: 4, gapMs: 0 };
const TENANT: HostPolicy = { concurrency: 2, gapMs: 250 };

export const POLICY: Record<string, HostPolicy> = {
  greenhouse: FAST,
  lever: FAST,
  ashby: FAST,
  smartrecruiters: FAST,
  // One request per board, but a board can be a multi-MB payload: stay gentle on the shared host.
  workable: { concurrency: 2, gapMs: 250 },
  recruitee: FAST,
  workday: TENANT,
  oraclecloud: TENANT,
  personio: TENANT,
  // One RSS feed per board (up to ~0.4 MB), on each company's own subdomain.
  teamtailor: FAST,
  bamboohr: TENANT,
  icims: TENANT,
  // Shared feed host throttles large responses aggressively.
  jobvite: { concurrency: 1, gapMs: 3000 },
  // Public search JSON, 100 full rows per request: one shared host, so stay sequential and spaced.
  amazon: { concurrency: 1, gapMs: 500 },
  // Whole-board HTML pages (about 1.3 MB each): 151 requests for the full board.
  google: { concurrency: 2, gapMs: 250 },
  // One shared host, and each detail is a ~1 MB job page: read a few at a time.
  meta: { concurrency: 2, gapMs: 500 },
  // Eightfold answers 429 after short bursts; one detail request per second stays polite.
  netflix: { concurrency: 1, gapMs: 1000 },
};

/** Unknown platforms get the careful policy. */
export const policyFor = (platform: string): HostPolicy => POLICY[platform] ?? TENANT;

/** The policy of the platform that owns `host` (by its allowlist), or the careful default. */
export function policyForHost(host: string): HostPolicy {
  for (const platform of Object.values(platforms)) {
    if (hostAllowed(host, platform.hosts)) return policyFor(platform.id);
  }
  return TENANT;
}
