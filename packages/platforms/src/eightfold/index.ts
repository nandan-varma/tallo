import type { CollectContext, Json, JsonObject, Platform, RawPosting } from "@tallo/contracts";
import { arr, isObject, num, obj, str } from "@tallo/contracts";
import {
  captureGroups,
  describe,
  locations,
  lookup,
  PostingGone,
  SchemaError,
  uniqueWithinBudget,
  workModeOf,
} from "../kit.ts";

/**
 * Eightfold "PCSX" career sites (Microsoft, Starbucks). The listing is the site's sitemap (one request, every
 * posting with its `lastmod`); a posting's text comes from one `position_details` call, made only for postings
 * whose `lastmod` changed. The `search` endpoint answers only 10 rows per request and rate-limits hard (a plain
 * "Please try again later" 429 after a few quick requests), so it is read once, for the reported total.
 */

/** One `<url>` block of the sitemap, the job address inside it (`/careers/job/<positionId>-<slug>`), its `lastmod`. */
const SITEMAP_URL = /<url>([\s\S]*?)<\/url>/g;
const JOB_LOC = /<loc>[^<]*\/careers\/job\/(\d{1,20})-?[^<]*<\/loc>/;
const LASTMOD = /<lastmod>([^<]+)<\/lastmod>/;

export interface EightfoldSite {
  /** Platform id (`microsoft`, `starbucks`). */
  id: string;
  /** Display name used in errors. */
  name: string;
  /** The careers host, e.g. `apply.careers.microsoft.com`. */
  host: string;
  /** The Eightfold domain, e.g. `microsoft.com`; the only valid source key. */
  domain: string;
}

/** The data object of an Eightfold PCSX answer, whose envelope states its own status. */
function dataOf(answer: unknown, label: string): JsonObject {
  if (!isObject(answer)) throw new SchemaError(`${label} answer is not an object`);
  if (answer.status !== undefined && answer.status !== 200)
    throw new SchemaError(`${label} answer has status ${String(answer.status)}`);
  if (!isObject(answer.data)) throw new SchemaError(`${label} answer without data`);
  return answer.data;
}

const isoFromSeconds = (value: unknown): string | undefined => {
  const seconds = num(value);
  return seconds === undefined || seconds <= 0 ? undefined : new Date(seconds * 1000).toISOString();
};

const first = (value: unknown): string | undefined => str(arr(value)[0]);

/** A text the site states either as one string or as a one-item list. */
const text = (value: unknown): string | undefined => str(value) ?? first(value);

/** Pay text a site states per market (Starbucks), kept as the source wrote it. */
const PAY_FIELDS: [extra: string, field: string][] = [
  ["payRange", "efcustomTextPayRange"],
  ["payRangeNonRetail", "efcustomTextPayRangenonretail"],
  ["payRateRangeUs", "efcustomTextPayRateRangeUs"],
  ["payRateRangeCanada", "efcustomTextPayRateRangeCanada"],
  ["payRateRangeCanadaAlt", "efcustomTextPayraterangecanada"],
  ["payRateCanadaRetailHourly", "efcustomTextPcsPayrateCanadaRetailHourly"],
];

/** One posting per job `<url>` block of the sitemap, with its `lastmod` when it states one. */
function* sitemapPostings(xml: string): Generator<RawPosting> {
  for (const [block = ""] of captureGroups(SITEMAP_URL, xml)) {
    const id = JOB_LOC.exec(block)?.[1];
    if (!id) continue;
    const lastmod = LASTMOD.exec(block)?.[1];
    yield { id, listing: { id, ...(lastmod ? { lastmod } : {}) } };
  }
}

export function eightfold(site: EightfoldSite): Platform {
  const { name } = site;
  const origin = `https://${site.host}`;
  const searchUrl = (start: number): string =>
    `${origin}/api/pcsx/search?domain=${site.domain}&query=&location=&start=${start}&sort_by=timestamp`;

  /** Only the site's own careers URL is linked. */
  const pageUrlOf = (value: unknown): string | undefined => {
    const link = str(value);
    if (!link) return undefined;
    try {
      const url = new URL(link);
      return url.protocol === "https:" && url.hostname === site.host ? url.href : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * True when the site's own reported total (one `search` call) matches the sitemap's count. A sitemap that is missing
   * postings, or a total that cannot be read, is an incomplete listing: nothing may be closed on it.
   */
  const agreesWithReportedTotal = async (listed: number, ctx: CollectContext): Promise<boolean> => {
    try {
      const page = dataOf((await ctx.http.getJson(searchUrl(0))).data, `${name} search`);
      const reported = num(page.count);
      if (reported === undefined || !Number.isInteger(reported) || reported < 0)
        throw new SchemaError(`${name} search reported no valid count`);
      // The sitemap and the search are read a moment apart, so a few postings may differ either way.
      if (Math.abs(listed - reported) <= Math.max(5, Math.ceil(reported * 0.01))) return true;
      ctx.record({
        code: "pagination",
        message: `${name} sitemap lists ${listed} postings but the site reports ${reported}`,
      });
    } catch (error) {
      ctx.record({
        code: "pagination",
        message: `${name} total could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return false;
  };

  return {
    id: site.id,
    version: 2,
    hosts: [site.host],
    validate(source) {
      if (source.key !== site.domain)
        throw new Error(`${name} source key must be ${site.domain}: ${source.key}`);
    },

    /**
     * The listing is the site's own sitemap (robots.txt allows `/careers`): every posting's id and `lastmod` in one
     * request, instead of one `search` call per 10 postings. `search` is the endpoint these sites throttle hard (a
     * plain 429 after a few quick requests); `position_details` is not. One `search` call still reads the reported
     * total, so a sitemap that is missing postings is an incomplete listing and never closes anything.
     */
    async *list(_source, ctx) {
      const xml = (await ctx.http.getText(`${origin}/careers/sitemap.xml?domain=${site.domain}`))
        .data;
      if (!xml.includes("<urlset")) throw new SchemaError(`${name} sitemap is not a urlset`);
      const { complete: whole, listed } = yield* uniqueWithinBudget(sitemapPostings(xml), ctx);
      if (!whole) return { complete: false, emptyIsAuthoritative: false };
      if (listed === 0) throw new SchemaError(`${name} sitemap lists no postings`);
      return { complete: await agreesWithReportedTotal(listed, ctx), emptyIsAuthoritative: false };
    },

    async detail(_source, posting, ctx) {
      const url = `${origin}/api/pcsx/position_details?position_id=${encodeURIComponent(posting.id)}&domain=${site.domain}&hl=en`;
      try {
        return dataOf((await ctx.http.getJson(url)).data, `${name} position_details`);
      } catch (error) {
        // A closed position is a 404 while the sitemap may still list it for a while.
        if ((error as { status?: unknown } | null)?.status === 404)
          throw new PostingGone(`${name} position ${posting.id} is gone (404)`);
        throw error;
      }
    },

    /** The sitemap's `lastmod` is the only thing the listing says about a posting changing. */
    fingerprint: (listing) => ({ lastmod: str(obj(listing).lastmod) ?? null }),

    map({ id: postingId, listing, detail }) {
      const j = lookup(detail, listing);
      const url = pageUrlOf(j("publicUrl")) ?? `${origin}/careers/job/${postingId}`;
      const extras: JsonObject = {};
      const put = (key: string, value: Json | undefined) => {
        if (value !== undefined) extras[key] = value;
      };
      put("roleType", first(j("efcustomTextRoletype")));
      put("workSite", first(j("efcustomTextWorkSite")));
      put("requiredTravel", first(j("efcustomTextRequiredTravel")));
      put("profession", first(j("efcustomTextCurrentProfession")));
      put("discipline", first(j("efcustomTextTaDisciplineName")));
      put("jobFunction", first(j("efcustomTextJobFunctionLevel1")));
      put("jobSubFunction", first(j("efcustomTextJobFunctionLevel2")));
      put("hiringBand", first(j("efcustomTextPositionHiringBand")));
      put("bonus", first(j("efcustomTextPositionBonus")));
      for (const [key, field] of PAY_FIELDS) put(key, text(j(field)));
      put("locationFlexibility", str(j("locationFlexibility")));
      put("createdAt", isoFromSeconds(j("creationTs")));
      put("displayJobId", str(j("displayJobId")));
      const standardized = arr(j("standardizedLocations"));
      if (standardized.length > 0) put("standardizedLocations", standardized);
      return {
        postingId,
        title: str(j("name")) ?? "",
        url,
        applyUrl: url,
        description: describe(j("jobDescription")),
        locations: locations(arr(j("locations")).map((value) => ({ text: value }))),
        workMode: workModeOf(j("workLocationOption")),
        department: str(j("department")),
        employmentType: first(j("efcustomTextEmploymentType")),
        requisitionId: str(j("atsJobId")) ?? str(j("displayJobId")),
        postedAt: isoFromSeconds(j("postedTs")),
        expiresAt: isoFromSeconds(arr(j("efcustomIntExtPostExpDate"))[0]),
        compensation: [],
        experience: [],
        extras,
      };
    },
  };
}
