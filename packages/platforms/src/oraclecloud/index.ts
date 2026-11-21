import type {
  CollectContext,
  JsonObject,
  Platform,
  RawPosting,
  SourceConfig,
} from "@tallo/contracts";
import { arr, id, num, obj, str } from "@tallo/contracts";
import { describe, locations, lookup, rows, SchemaError, workModeOf } from "../kit.ts";

const PAGE = 100;
/** The finder answers at most 10,000 results per query; offset 10000 is an empty page, not an error. */
const CAP = 10_000;
/** Recruiting pods seen in seeds: `<tenant>.fa.oraclecloud.com`, `.fa.us2.`, `.fa.ocs.`. Not all of `*.oraclecloud.com`. */
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.fa\.(?:(?:us2|ocs)\.)?oraclecloud\.com$/;
const SITE = /^[A-Za-z0-9_]+$/;
/** A siteNumber no board uses. Oracle answers it with the host's default site, which is what exposes a typo. */
const NO_SUCH_SITE = "CX_TALLO_NO_SUCH_SITE";

const api = (source: SourceConfig) => `https://${source.key}/hcmRestApi/resources/latest`;
const siteOf = (source: SourceConfig) => String(source.params.siteNumber ?? "");

const finderUrl = (source: SourceConfig, site: string, limit: number, offset: number) =>
  `${api(source)}/recruitingCEJobRequisitions?onlyData=true` +
  `&expand=requisitionList.secondaryLocations` +
  `&finder=findReqs;siteNumber=${site},limit=${limit},offset=${offset},keyword=`;

/** The first item of a finder response; a missing item is a shape change, never an empty board. */
function firstItem(data: unknown): JsonObject {
  const [item] = rows(obj(data).items, "items");
  if (!item) throw new SchemaError("Oracle Cloud response without items");
  return item;
}

/**
 * A wrong siteNumber silently reads the host's default board, so the first non-empty page must
 * differ from a probe of a site that cannot exist. Sources that really are the host default say so with
 * `params.defaultSite: true`.
 */
async function assertNotHostDefault(
  source: SourceConfig,
  ctx: CollectContext,
  total: number,
  firstId: unknown,
): Promise<void> {
  if (source.params.defaultSite === true || total === 0) return;
  const real = id(firstId);
  if (real === undefined) return;
  const probe = firstItem((await ctx.http.getJson(finderUrl(source, NO_SUCH_SITE, 1, 0))).data);
  const probeFirst = id(rows(probe.requisitionList, "requisitionList")[0]?.Id);
  // Either signal alone counts: a typo'd site can share the newest posting or the total with the default.
  if (num(probe.TotalJobsCount) === total || probeFirst === real)
    throw new SchemaError(
      `Oracle Cloud siteNumber ${siteOf(source)} answers like the host's default site; ` +
        "if it is the host default, set params.defaultSite: true",
    );
}

/** Keeps only the defined entries; `extras` must stay JSON. */
const definedOnly = (fields: Record<string, string | undefined>): JsonObject =>
  Object.fromEntries(
    Object.entries(fields).filter((e): e is [string, string] => e[1] !== undefined),
  );

export const oraclecloud: Platform = {
  id: "oraclecloud",
  version: 3,
  hosts: ["*.fa.oraclecloud.com", "*.fa.us2.oraclecloud.com", "*.fa.ocs.oraclecloud.com"],
  validate(source) {
    if (!HOST.test(source.key))
      throw new Error(
        `Oracle Cloud key must be a *.fa[.us2|.ocs].oraclecloud.com host: ${source.key}`,
      );
    if (!SITE.test(siteOf(source)))
      throw new Error(`Oracle Cloud source needs params.siteNumber: ${source.key}`);
    if (source.params.defaultSite !== undefined && typeof source.params.defaultSite !== "boolean")
      throw new Error(`Oracle Cloud params.defaultSite must be true or false: ${source.key}`);
  },

  async *list(source, ctx) {
    let total = Number.POSITIVE_INFINITY;
    let complete = true;
    let siteChecked = false;
    for (let offset = 0; offset < total; offset += PAGE) {
      if (offset >= CAP) {
        complete = false;
        ctx.record({
          code: "pagination",
          message: `Oracle Cloud listing caps at ${CAP} results; board has ${total}`,
        });
        break;
      }
      const page = firstItem(
        (await ctx.http.getJson(finderUrl(source, siteOf(source), PAGE, offset))).data,
      );
      const count = num(page.TotalJobsCount);
      if (count === undefined)
        throw new SchemaError("Oracle Cloud response without TotalJobsCount");
      total = count;
      const jobs = rows(page.requisitionList, "requisitionList");
      if (!siteChecked && jobs.length > 0) {
        await assertNotHostDefault(source, ctx, count, jobs[0]?.Id);
        siteChecked = true;
      }
      for (const job of jobs) {
        const postingId = id(job.Id);
        if (!postingId) throw new SchemaError("Oracle Cloud requisition without Id");
        yield { id: postingId, listing: job } satisfies RawPosting;
      }
      if (jobs.length < PAGE && offset + jobs.length < total) {
        complete = false;
        ctx.record({ code: "pagination", message: `Short page at offset ${offset}` });
        // The finder can omit rows within a page while later offsets still contain jobs.
        // Keep collecting those pages, but never infer closure from the incomplete listing.
      }
    }
    return { complete, emptyIsAuthoritative: false };
  },

  async detail(source, posting, ctx) {
    const url =
      `${api(source)}/recruitingCEJobRequisitionDetails?expand=all` +
      `&finder=ById;Id="${encodeURIComponent(posting.id)}",siteNumber=${siteOf(source)}`;
    return firstItem((await ctx.http.getJson(url)).data);
  },

  fingerprint: (listing) => {
    // Relevancy, distance and marketing flags change per query; they must not trigger a detail refetch.
    const { Relevancy, Distance, TrendingFlag, HotJobFlag, BeFirstToApplyFlag, ...stable } =
      obj(listing);
    return stable;
  },

  map({ id: postingId, listing, detail }, source) {
    const j = lookup(detail, listing);
    const sitePath = str(source.params.sitePath) ?? siteOf(source);
    const country = str(j("PrimaryLocationCountry"));
    // The detail's structured work location names the city; Region1/Region2 are not ISO regions.
    const city = str(obj(arr(j("workLocation"))[0]).TownOrCity);
    const applyUrl = `https://${source.key}/hcmUI/CandidateExperience/en/sites/${sitePath}/job/${postingId}`;
    const secondary = [
      ...arr(lookup(detail)("secondaryLocations")),
      ...arr(lookup(listing)("secondaryLocations")),
    ];
    return {
      postingId,
      title: str(j("Title")) ?? "",
      url: applyUrl,
      applyUrl,
      description:
        describe(
          j("ExternalDescriptionStr"),
          j("ExternalResponsibilitiesStr"),
          j("ExternalQualificationsStr"),
        ) || describe(j("ShortDescriptionStr")),
      locations: locations([
        { text: j("PrimaryLocation"), hints: { city, countryCode: country } },
        ...secondary.map((s) => ({
          text: obj(s).Name,
          hints: { countryCode: str(obj(s).CountryCode) },
        })),
      ]),
      workMode: workModeOf(j("WorkplaceType")),
      department: str(j("Department")) ?? str(j("Category")),
      team: str(j("JobFamily")) ?? str(j("JobFunction")),
      employmentType: str(j("JobSchedule")),
      requisitionId: str(j("RequisitionId")),
      postedAt: str(j("ExternalPostedStartDate")) ?? str(j("PostedDate")),
      expiresAt: str(j("ExternalPostedEndDate")) ?? str(j("PostingEndDate")),
      compensation: [],
      experience: [],
      extras: definedOnly({
        language: str(j("Language")),
        businessUnit: str(j("BusinessUnit")),
        jobFunction: str(j("JobFunction")),
        jobGrade: str(j("JobGrade")),
        workplaceTypeCode: str(j("WorkplaceTypeCode")),
      }),
    };
  },
};
