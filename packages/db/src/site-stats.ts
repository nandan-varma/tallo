import { type SiteStats, STALE_FLAG_DAYS, STALE_HIDE_DAYS } from "@tallo/contracts";
import { and, between, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { jobs, runs, sources as sources_ } from "./schema.ts";

/** The sample: `SAMPLE_WINDOWS` runs of `SAMPLE_SPAN` consecutive ids, spread over the id range. At most 150k rows read. */
const SAMPLE_WINDOWS = 5;
const SAMPLE_SPAN = 30_000;
const TOP_EMPLOYERS = 15;
const TOP_COUNTRIES = 12;
const DAY = 86400;

interface SourceRow {
  id: string;
  platform: string;
  company: string;
  slug: string;
  status: string;
  listed: number | null;
  ran: number | null;
}

/**
 * The /status numbers, from a bounded set of reads (rows read, approximately, on production):
 * - `sources` (one pass, ~9k rows): boards, platforms, freshness, newest run, and the platform and employer maps.
 * - `runs` complete in the last 14 days, last one per board (~74k rows read): open postings per board (`seen`).
 * - `runs` of the last 7 days (~19k rows): postings added and closed.
 * - a sample of jobs, 5 id windows of 30k (up to 150k rows): country, work mode, pay and posted-date shares.
 * Nothing scans the whole jobs table. Run it rarely; the web Worker caches the answer for half a day.
 */
export async function siteStats(db: Db, now = Math.floor(Date.now() / 1000)): Promise<SiteStats> {
  const sources: SourceRow[] = await db
    .select({
      id: sources_.id,
      platform: sources_.platform,
      company: sources_.company,
      slug: sources_.companySlug,
      status: sources_.status,
      listed: sources_.lastListedAt,
      ran: sources_.lastRunAt,
    })
    .from(sources_);
  const lastListing = await db
    .select({ id: runs.sourceId, seen: runs.seen, last: sql<number>`max(${runs.startedAt})` })
    .from(runs)
    .where(and(eq(runs.status, "complete"), gt(runs.startedAt, now - STALE_HIDE_DAYS * DAY)))
    .groupBy(runs.sourceId);
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
  const [top] = await db.select({ top: sql<number | null>`max(${jobs.id})` }).from(jobs);
  const maxId = top?.top ?? 0;
  const span = Math.min(SAMPLE_SPAN, maxId);
  const sampled = await Promise.all(
    // A small id range is one window (spread windows would overlap and count rows twice).
    Array.from({ length: maxId <= SAMPLE_WINDOWS * span ? 1 : SAMPLE_WINDOWS }, (_, i) => {
      const from = 1 + Math.floor((i * (maxId - span)) / (SAMPLE_WINDOWS - 1));
      return db
        .select({
          c: jobs.countryCode,
          w: jobs.workMode,
          n: sql<number>`count(*)`,
          po: sql<number>`sum(${jobs.postedAt} IS NOT NULL)`,
          pay: sql<number>`sum(coalesce(json_array_length(json_extract(${jobs.facts}, '$.compensation')), 0) > 0)`,
        })
        .from(jobs)
        .where(
          and(
            between(
              jobs.id,
              from,
              Math.max(from + span, maxId <= SAMPLE_WINDOWS * span ? maxId : 0),
            ),
            isNull(jobs.closedAt),
            isNull(jobs.dupOf),
          ),
        )
        .groupBy(jobs.countryCode, jobs.workMode);
    }),
  );

  const seen = new Map(lastListing.map((r) => [r.id, r.seen ?? 0]));
  const active = sources.filter((s) => s.status === "active");
  const fresh = new Set(
    active.filter((s) => s.listed !== null && s.listed >= now - STALE_HIDE_DAYS * DAY),
  );
  const platforms = new Map<string, { boards: number; open: number }>();
  for (const s of active) {
    const entry = platforms.get(s.platform) ?? { boards: 0, open: 0 };
    entry.boards += 1;
    entry.open += fresh.has(s) ? (seen.get(s.id) ?? 0) : 0;
    platforms.set(s.platform, entry);
  }
  const employers = new Map<string, { name: string; open: number }>();
  for (const s of fresh) {
    const entry = employers.get(s.slug) ?? { name: s.company, open: 0 };
    entry.open += seen.get(s.id) ?? 0;
    employers.set(s.slug, entry);
  }

  let total = 0;
  const modes = { remote: 0, hybrid: 0, onsite: 0, unstated: 0 };
  const countries = new Map<string, number>();
  let pay = 0;
  let posted = 0;
  let countryStated = 0;
  for (const r of sampled.flat()) {
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
  const share = (n: number) => (total ? n / total : 0);

  return {
    asOf: now,
    openJobs: [...employers.values()].reduce((sum, e) => sum + e.open, 0),
    employers: employers.size,
    boards: active.length,
    platforms: platforms.size,
    freshness: {
      listed7d: active.filter((s) => s.listed !== null && s.listed >= now - STALE_FLAG_DAYS * DAY)
        .length,
      listed14d: fresh.size,
      newestRunAt: sources.reduce<number | null>(
        (m, s) => (s.ran !== null && (m === null || s.ran > m) ? s.ran : m),
        null,
      ),
      added24h: window?.day ?? 0,
      added7d: window?.added ?? 0,
      closed7d: window?.closed ?? 0,
    },
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
    sampleSize: total,
  };
}
