import { createHostLimiter, hostAllowed, podKey } from "@tallo/http";
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
  rippling: TENANT,
  gem: TENANT,
  pinpoint: TENANT,
  breezy: TENANT,
  // Eightfold sites sit behind an edge firewall with a per-IP rate rule: Starbucks blocked the Mac's IP after about
  // 1,000 requests at 2 a second (everything answered 403 for about 5 minutes). Stay well under it.
  microsoft: { concurrency: 1, gapMs: 1000 },
  starbucks: { concurrency: 1, gapMs: 2000 },
  // About 4,500 job pages of ~150 KB each, on one host.
  fedex: { concurrency: 2, gapMs: 500 },
  // One 100-row search page per request, then one ~85 KB job page per changed posting, on one host.
  // One sitemap, then one ~290 KB portal page JSON per changed posting on one host.
  bestbuy: { concurrency: 2, gapMs: 500 },
  phenom: { concurrency: 2, gapMs: 500 },
  // One sitemap or RSS feed, then one job page per changed posting, on each company's own host.
  successfactors: { concurrency: 2, gapMs: 500 },
  ibm: TENANT,
  goldman: TENANT,
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
  // One 30 KB listing page plus one compact detail per changed posting, on Apple's shared API host.
  apple: { concurrency: 3, gapMs: 150 },
  // One shared host, and each detail is a ~1 MB job page: read a few at a time.
  meta: { concurrency: 2, gapMs: 500 },
  // Eightfold answers 429 after short bursts; one detail request per second stays polite.
  netflix: { concurrency: 1, gapMs: 1000 },
  // One sitemap, then one ~30 KB job page per new posting on a single Akamai-fronted host.
  walmart: { concurrency: 1, gapMs: 700 },
  // One sitemap, then one job page (~0.5 MB) per new posting on each employer's own host.
  radancy: { concurrency: 1, gapMs: 700 },
};

/** A registered platform must explicitly choose its baseline. */
export function policyFor(platform: string): HostPolicy {
  const policy = POLICY[platform];
  if (!policy) throw new Error(`No host policy for ${platform}`);
  return policy;
}

/** The policy of the platform that owns `host` (by its allowlist), or the careful default. */
export function policyForHost(host: string): HostPolicy {
  for (const platform of Object.values(platforms)) {
    if (hostAllowed(host, platform.hosts)) return policyFor(platform.id);
  }
  return TENANT;
}

/** Shared Mac/default limits; sweep and cloud add their adaptive/distributed coordination. */
export function createPlatformLimiter(overrides: { concurrency?: number; gapMs?: number } = {}) {
  return createHostLimiter({
    hostKey: podKey,
    perHostConcurrency: (host) => overrides.concurrency ?? policyForHost(host).concurrency,
    minHostIntervalMs: (host) => overrides.gapMs ?? policyForHost(host).gapMs,
  });
}
