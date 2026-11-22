import {
  SITE_STATS_HISTORY_DAYS,
  type SiteStats,
  STALE_FLAG_DAYS,
  STALE_HIDE_DAYS,
} from "@tallo/contracts";
import { and, between, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { jobs, runs, siteSnapshot, sources as sources_ } from "./schema.ts";

const TOP_EMPLOYERS = 15;
const TOP_COUNTRIES = 12;
const DAY = 86400;
/** The catalog count is repeated after this long; the cheap live part runs on every refresh. */
const CATALOG_EVERY = 20 * 3600;
/** Job ids per catalog query: keeps each statement short and the number of statements small. */
const PAGE = 50_000;

interface SourceRow {
  id: string;
  platform: string;
  company: string;
  slug: string;
  status: string;
  failures: number;
  listed: number | null;
  ran: number | null;
}

type Live = Pick<SiteStats, "boards" | "platforms" | "freshness" | "health">;
type Catalog = Omit<
  SiteStats,
  "asOf" | "boards" | "platforms" | "freshness" | "health" | "history"
>;

/**
 * The /status numbers. `refreshSiteStats` (the API's hourly cron) is the only thing that reads the catalog for them:
 * - every run: `sources` (~9k rows) and the runs of the last 7 days (~19k rows): boards, freshness, health.
 * - about once a day: every open job once, paged by id (a few hundred thousand rows), grouped in SQL: open jobs,
 *   employers, platforms, countries, work mode, pay and posted-date shares. Exact counts, no sampling.
 * The result is one row; `readSiteStats` is a single-row read, which is all a page view ever costs the database.
 */
export async function refreshSiteStats(
  db: Db,
  now = Math.floor(Date.now() / 1000),
  { force = false }: { force?: boolean } = {},
): Promise<SiteStats> {
  const previous = await readSiteStats(db);
  const sources = await readSources(db);
  const live = await liveStats(db, sources, now);
  const reuse = !force && previous && now - previous.catalogAsOf < CATALOG_EVERY ? previous : null;
  const catalog = reuse ?? (await catalogStats(db, sources, now));
  const stats: SiteStats = {
    ...catalog,
    ...live,
    asOf: now,
    history: reuse ? reuse.history : withToday(previous?.history ?? [], catalog, live, now),
  };
  const row = { computedAt: now, catalogAt: stats.catalogAsOf, body: stats };
  await db
    .insert(siteSnapshot)
    .values({ id: 1, ...row })
    .onConflictDoUpdate({ target: siteSnapshot.id, set: row });
  return stats;
}

/** The stored snapshot, or null before the first refresh. One row read. */
export async function readSiteStats(db: Db): Promise<SiteStats | null> {
  const [row] = await db
    .select({ body: siteSnapshot.body })
    .from(siteSnapshot)
    .where(eq(siteSnapshot.id, 1));
  return row?.body ?? null;
}

const readSources = (db: Db): Promise<SourceRow[]> =>
  db
    .select({
      id: sources_.id,
      platform: sources_.platform,
      company: sources_.company,
      slug: sources_.companySlug,
      status: sources_.status,
      failures: sources_.failureCount,
      listed: sources_.lastListedAt,
      ran: sources_.lastRunAt,
    })
    .from(sources_);

const isFresh = (s: SourceRow, now: number) =>
  s.status === "active" && s.listed !== null && s.listed >= now - STALE_HIDE_DAYS * DAY;

async function liveStats(db: Db, sources: SourceRow[], now: number): Promise<Live> {
  const [window] = await db
    .select({
      added: sql<number | null>`sum(${runs.added})`,
      closed: sql<number | null>`sum(${runs.closed})`,
      day: sql<
        number | null
      >`sum(CASE WHEN ${runs.startedAt} > ${now - DAY} THEN ${runs.added} ELSE 0 END)`,
    })
    .from(runs)
    .where(gt(runs.startedAt, now - 7 * DAY));
  const active = sources.filter((s) => s.status === "active");
  return {
    boards: active.length,
    platforms: new Set(active.map((s) => s.platform)).size,
    freshness: {
      listed7d: active.filter((s) => s.listed !== null && s.listed >= now - STALE_FLAG_DAYS * DAY)
        .length,
      listed14d: active.filter((s) => isFresh(s, now)).length,
      newestRunAt: sources.reduce<number | null>(
        (m, s) => (s.ran !== null && (m === null || s.ran > m) ? s.ran : m),
        null,
      ),
      added24h: window?.day ?? 0,
      added7d: window?.added ?? 0,
      closed7d: window?.closed ?? 0,
    },
    health: {
      failing: active.filter((s) => s.failures > 0).length,
      dead: sources.length - active.length,
    },
  };
}

async function catalogStats(db: Db, sources: SourceRow[], now: number): Promise<Catalog> {
  const [top] = await db.select({ top: sql<number | null>`max(${jobs.id})` }).from(jobs);
  const maxId = top?.top ?? 0;
  const bySource = new Map<string, number>();
  const countries = new Map<string, number>();
  const modes = { remote: 0, hybrid: 0, onsite: 0, unstated: 0 };
  let total = 0;
  let pay = 0;
  let posted = 0;
  let countryStated = 0;
  const fresh = new Set(sources.filter((s) => isFresh(s, now)).map((s) => s.id));

  for (let from = 1; from <= maxId; from += PAGE) {
    const rows = await db
      .select({
        s: jobs.sourceId,
        c: jobs.countryCode,
        w: jobs.workMode,
        n: sql<number>`count(*)`,
        po: sql<number>`sum(${jobs.postedAt} IS NOT NULL)`,
        pay: sql<number>`sum(coalesce(json_array_length(json_extract(${jobs.facts}, '$.compensation')), 0) > 0)`,
      })
      .from(jobs)
      .where(
        and(between(jobs.id, from, from + PAGE - 1), isNull(jobs.closedAt), isNull(jobs.dupOf)),
      )
      .groupBy(jobs.sourceId, jobs.countryCode, jobs.workMode);
    for (const r of rows) {
      // Search hides boards that stopped listing, so the headline numbers leave them out too.
      if (!fresh.has(r.s)) continue;
      bySource.set(r.s, (bySource.get(r.s) ?? 0) + r.n);
      total += r.n;
      pay += r.pay ?? 0;
      posted += r.po ?? 0;
      const mode = r.w === "remote" || r.w === "hybrid" || r.w === "onsite" ? r.w : "unstated";
      modes[mode] += r.n;
      if (r.c) {
        countryStated += r.n;
        countries.set(r.c, (countries.get(r.c) ?? 0) + r.n);
      }
    }
  }

  const platforms = new Map<string, { boards: number; open: number }>();
  for (const s of sources.filter((s) => s.status === "active")) {
    const entry = platforms.get(s.platform) ?? { boards: 0, open: 0 };
    entry.boards += 1;
    entry.open += bySource.get(s.id) ?? 0;
    platforms.set(s.platform, entry);
  }
  const employers = new Map<string, { name: string; open: number }>();
  for (const s of sources.filter((s) => fresh.has(s.id))) {
    const entry = employers.get(s.slug) ?? { name: s.company, open: 0 };
    entry.open += bySource.get(s.id) ?? 0;
    employers.set(s.slug, entry);
  }
  const share = (n: number) => (total ? n / total : 0);

  return {
    catalogAsOf: now,
    openJobs: total,
    collectedTotal: maxId,
    employers: employers.size,
    byPlatform: [...platforms]
      .map(([platform, v]) => ({ platform, ...v }))
      .sort((a, b) => b.open - a.open || a.platform.localeCompare(b.platform)),
    topEmployers: [...employers.values()]
      .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
      .slice(0, TOP_EMPLOYERS),
    countries: {
      distinct: countries.size,
      top: [...countries]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP_COUNTRIES)
        .map(([code, n]) => ({ code, share: share(n) })),
    },
    mix: {
      remote: share(modes.remote),
      hybrid: share(modes.hybrid),
      onsite: share(modes.onsite),
      unstated: share(modes.unstated),
      payStated: share(pay),
      postedStated: share(posted),
      countryStated: share(countryStated),
    },
  };
}

/** Today's point replaces an earlier one of the same UTC day; the series keeps the newest SITE_STATS_HISTORY_DAYS. */
function withToday(history: SiteStats["history"], catalog: Catalog, live: Live, now: number) {
  const day = now - (now % DAY);
  return [
    ...history.filter((p) => p.day !== day),
    { day, openJobs: catalog.openJobs, added: live.freshness.added24h },
  ]
    .sort((a, b) => a.day - b.day)
    .slice(-SITE_STATS_HISTORY_DAYS);
}
