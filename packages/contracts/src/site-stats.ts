import { z } from "zod";

/**
 * The numbers behind the /status page. One snapshot, computed by the API's hourly cron (the catalog part once a day)
 * and stored as a single row, so a page view never reads the catalog: the web Worker fetches that one row and keeps it
 * at the edge for a few minutes. Figures are exact counts of what the catalog holds, as of `asOf` / `catalogAsOf`.
 */
export const SITE_STATS_TTL_SECONDS = 300;
export const SITE_STATS_CACHE_CONTROL = `public, max-age=${SITE_STATS_TTL_SECONDS}, s-maxage=${SITE_STATS_TTL_SECONDS}, stale-while-revalidate=3600`;

/** How many daily points of history a snapshot carries. */
export const SITE_STATS_HISTORY_DAYS = 60;

const count = z.number().int().nonnegative();
const share = z.number().min(0).max(1);

export const siteStatsSchema = z.object({
  asOf: count,
  catalogAsOf: count,
  openJobs: count,
  collectedTotal: count,
  employers: count,
  boards: count,
  platforms: count,
  freshness: z.object({
    listed7d: count,
    listed14d: count,
    newestRunAt: count.nullable(),
    added24h: count,
    added7d: count,
    closed7d: count,
  }),
  health: z.object({ failing: count, dead: count }),
  byPlatform: z.array(z.object({ platform: z.string(), boards: count, open: count })),
  topEmployers: z.array(z.object({ name: z.string(), open: count })),
  countries: z.object({ distinct: count, top: z.array(z.object({ code: z.string(), share })) }),
  mix: z.object({
    remote: share,
    hybrid: share,
    onsite: share,
    unstated: share,
    payStated: share,
    postedStated: share,
    countryStated: share,
  }),
  history: z.array(z.object({ day: count, openJobs: count, added: count })),
});
export type SiteStats = z.infer<typeof siteStatsSchema>;
