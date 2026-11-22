/**
 * The numbers behind the /status page. One snapshot, computed by the API's hourly cron (the catalog part once a day)
 * and stored as a single row, so a page view never reads the catalog: the web Worker fetches that one row and keeps it
 * at the edge for a few minutes. Figures are exact counts of what the catalog holds, as of `asOf` / `catalogAsOf`.
 */
export const SITE_STATS_TTL_SECONDS = 300;
export const SITE_STATS_CACHE_CONTROL = `public, max-age=${SITE_STATS_TTL_SECONDS}, s-maxage=${SITE_STATS_TTL_SECONDS}, stale-while-revalidate=3600`;

/** How many daily points of history a snapshot carries. */
export const SITE_STATS_HISTORY_DAYS = 60;

export interface SiteStats {
  /** Epoch seconds the live part (boards, freshness, health) was computed. */
  asOf: number;
  /** Epoch seconds the catalog part (open jobs, employers, countries, mix) was counted. */
  catalogAsOf: number;
  /** Open postings of boards that listed recently, duplicates folded into one. */
  openJobs: number;
  /** Postings ever collected, closed ones included. */
  collectedTotal: number;
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
  /** Collection health, from the boards' own state. */
  health: {
    /** Active boards whose last runs did not list completely. */
    failing: number;
    /** Boards retired after listing 404s. */
    dead: number;
  };
  byPlatform: { platform: string; boards: number; open: number }[];
  topEmployers: { name: string; open: number }[];
  countries: { distinct: number; top: { code: string; share: number }[] };
  /** Shares (0 to 1) of the open postings. A posting the source left blank is "unstated", never guessed. */
  mix: {
    remote: number;
    hybrid: number;
    onsite: number;
    unstated: number;
    payStated: number;
    postedStated: number;
    countryStated: number;
  };
  /** One point per day the catalog part was counted, oldest first. `day` is the UTC midnight, epoch seconds. */
  history: { day: number; openJobs: number; added: number }[];
}
