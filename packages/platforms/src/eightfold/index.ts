import type { Json, JsonObject, Platform, RawPosting } from "@tallo/contracts";
import { arr, id, isObject, num, obj, str } from "@tallo/contracts";
import { describe, locations, lookup, SchemaError, workModeOf } from "../kit.ts";

/**
 * Eightfold "PCSX" career sites (Microsoft, Starbucks). The public search answers 10 rows per request and
 * carries no description, so a posting's text comes from one `position_details` call, made only for
 * postings whose listing changed. Microsoft rate-limits hard (a plain "Please try again later" 429 after a
 * few quick requests); the shared http layer retries those with backoff.
 */
const PAGE = 10;

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

export function eightfold(site: EightfoldSite): Platform {
  const { name } = site;
  const origin = `https://${site.host}`;
  const searchUrl = (start: number): string =>
    `${origin}/api/pcsx/search?domain=${site.domain}&query=&location=&start=${start}&sort_by=timestamp`;

  const positionIdOf = (row: JsonObject): string => {
    const positionId = id(row.id);
    if (!positionId || !/^\d{1,20}$/.test(positionId))
      throw new SchemaError(`${name} listing row without a numeric id`);
    return positionId;
  };

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

  return {
    id: site.id,
    version: 1,
    hosts: [site.host],
    validate(source) {
      if (source.key !== site.domain)
        throw new Error(`${name} source key must be ${site.domain}: ${source.key}`);
    },

    async *list(_source, ctx) {
      const seen = new Set<string>();
      let total: number | undefined;
      let complete = true;
      for (let start = 0; ; start += PAGE) {
        if (total !== undefined && start >= total) break;
        const data = dataOf((await ctx.http.getJson(searchUrl(start))).data, `${name} search`);
        const count = num(data.count);
        if (count === undefined || !Number.isSafeInteger(count) || count < 0)
          throw new SchemaError(`${name} search answer without a valid count`);
        if (!Array.isArray(data.positions) || !data.positions.every(isObject))
          throw new SchemaError(`${name} search answer without a positions array`);
        const page = data.positions as JsonObject[];
        if (page.length > PAGE)
          throw new SchemaError(`${name} search returned ${page.length} rows for a ${PAGE} page`);
        if (total === undefined) total = count;
        else if (count !== total) {
          // The board moved while paging, so an unread row may have shifted behind the cursor.
          complete = false;
          ctx.record({
            code: "pagination",
            message: `${name} count changed from ${total} to ${count} at start ${start}`,
          });
          total = count;
        }
        if (page.length === 0) {
          if (start < total) {
            complete = false;
            ctx.record({
              code: "pagination",
              message: `${name} search ended at start ${start} of ${total}`,
            });
          }
          break;
        }
        if (page.length < PAGE && start + PAGE < total) {
          complete = false;
          ctx.record({
            code: "pagination",
            message: `${name} short page (${page.length}) at start ${start} of ${total}`,
          });
        }
        for (const row of page) {
          const positionId = positionIdOf(row);
          if (seen.has(positionId)) {
            complete = false;
            ctx.record({
              code: "pagination",
              message: `${name} repeated position ${positionId} at start ${start}`,
            });
            continue;
          }
          seen.add(positionId);
          yield { id: positionId, listing: row } satisfies RawPosting;
          if (seen.size >= ctx.maxPostings) {
            ctx.record({ code: "budget", message: `Stopped at ${ctx.maxPostings} postings` });
            return { complete: false, emptyIsAuthoritative: false };
          }
        }
      }
      if (total === undefined) throw new SchemaError(`${name} search returned no page`);
      if (seen.size < total) {
        complete = false;
        ctx.record({
          code: "pagination",
          message: `${name} listing saw ${seen.size} of ${total} reported positions`,
        });
      }
      // The count of a real board is never zero; an empty answer proves nothing.
      return { complete, emptyIsAuthoritative: false };
    },

    async detail(_source, posting, ctx) {
      const url = `${origin}/api/pcsx/position_details?position_id=${encodeURIComponent(posting.id)}&domain=${site.domain}&hl=en`;
      return dataOf((await ctx.http.getJson(url)).data, `${name} position_details`);
    },

    /** Stars, relevance score and the "hot" flag are counters and ranking, not the posting. */
    fingerprint: (listing) => {
      const { stars, solrScore, isHot, ...stable } = obj(listing);
      return stable;
    },

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
