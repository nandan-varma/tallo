/**
 * The numbers behind the /status page. One snapshot, computed rarely (it is cached for half a day) from small tables
 * and a bounded sample, so the database is read a few hundred thousand rows per snapshot and not the whole catalog.
 * Figures marked approximate come from the last complete listing of each board or from the sample (see `sampleSize`).
 */
export const SITE_STATS_TTL_SECONDS = 12 * 3600;
export const SITE_STATS_CACHE_CONTROL = `public, max-age=${SITE_STATS_TTL_SECONDS}, s-maxage=${SITE_STATS_TTL_SECONDS}, stale-while-revalidate=${6 * SITE_STATS_TTL_SECONDS}`;

export interface SiteStats {
  /** Epoch seconds the snapshot was computed. */
  asOf: number;
  /** Open postings: the sum of what each fresh board's last complete listing contained. Approximate. */
  openJobs: number;
  /** Distinct companies among the boards that listed recently. */
  employers: number;
  /** Configured boards that are not retired. */
  boards: number;
  platforms: number;
  freshness: {
    /** Boards that listed any postings in the last 7 / 14 days, of `boards`. */
    listed7d: number;
    listed14d: number;
    /** Epoch seconds of the newest collection run, or null. */
    newestRunAt: number | null;
    added24h: number;
    added7d: number;
    closed7d: number;
  };
  byPlatform: { platform: string; boards: number; open: number }[];
  topEmployers: { name: string; open: number }[];
  /** From the sample. `distinct` counts every country code the sample saw. */
  countries: { distinct: number; top: { code: string; share: number }[] };
  /** Shares (0 to 1) of the sampled postings. A posting the source left blank is "unstated", never guessed. */
  mix: {
    remote: number;
    hybrid: number;
    onsite: number;
    unstated: number;
    payStated: number;
    postedStated: number;
    countryStated: number;
  };
  /** How many open postings the sample covered. */
  sampleSize: number;
}
