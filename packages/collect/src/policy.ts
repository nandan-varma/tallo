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

const FAST: HostPolicy = { concurrency: 8, gapMs: 0 };
const TENANT: HostPolicy = { concurrency: 2, gapMs: 250 };

export const POLICY: Record<string, HostPolicy> = {
  greenhouse: FAST,
  lever: FAST,
  ashby: FAST,
  smartrecruiters: FAST,
  workday: TENANT,
  oraclecloud: TENANT,
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
