import type { Json, JsonObject, Money, Platform, RawPosting } from "@tallo/contracts";
import { arr, isObject, num, obj, str } from "@tallo/contracts";
import { describe, locations, lookup, SchemaError } from "../kit.ts";

/**
 * Goldman Sachs careers (higher.gs.com). The site is a single-page app over a public GraphQL gateway
 * that answers without any login. One `roleSearch` page returns up to 250 complete roles including the
 * full description HTML, pay band and structured locations, so there is no per-posting detail call.
 *
 * The three experience groups of the public search are read (`INTERNAL_MOBILITY` is the staff view). A
 * role found under more than one group is yielded once.
 */
const API = "https://api-higher.gs.com/gateway/api/v1/graphql";
const PAGE = 250;
const EXPERIENCES = ["PROFESSIONAL", "EARLY_CAREER", "CAMPUS"];

const QUERY = `query GetRoles($searchQueryInput: RoleSearchQueryInput!) {
  roleSearch(searchQueryInput: $searchQueryInput) {
    page { pageSize pageNumber hasNext }
    totalCount
    items {
      roleId corporateTitle jobTitle jobFunction
      locations { state corporateRegion country city longitude latitude primary }
      status division shortDescription descriptionHtml skills
      lastPostedDate createdDate lastModifiedDate
      jobType { code description }
      externalJobStatus skillset applicationFlowId
      compensation { minSalary maxSalary currency }
      externalSource { sourceId secondarySourceId externalSourceType }
      educationLevel gradDegreeStartDate gradDegreeEndDate startDate endDate
    }
  }
}`;

const requestBody = (pageNumber: number): Json => ({
  query: QUERY,
  variables: {
    searchQueryInput: {
      page: { pageSize: PAGE, pageNumber },
      sort: { sortStrategy: "POSTED_DATE", sortOrder: "DESC" },
      searchTerm: "",
      experiences: EXPERIENCES,
      filters: [],
    },
  },
});

function pageOf(data: unknown): { total: number; hasNext: boolean; items: JsonObject[] } {
  if (!isObject(data)) throw new SchemaError("Goldman Sachs answer is not an object");
  if (Array.isArray(data.errors) && data.errors.length > 0)
    throw new SchemaError(
      `Goldman Sachs GraphQL error: ${str(obj(data.errors[0]).message) ?? "unknown"}`,
    );
  const search = obj(obj(data.data).roleSearch);
  const total = num(search.totalCount);
  if (total === undefined || !Number.isSafeInteger(total) || total < 0)
    throw new SchemaError("Goldman Sachs answer without a valid totalCount");
  const hasNext = bool(obj(search.page).hasNext);
  if (hasNext === undefined) throw new SchemaError("Goldman Sachs answer without page.hasNext");
  if (!Array.isArray(search.items) || !search.items.every(isObject))
    throw new SchemaError("Goldman Sachs answer without an items array");
  if (search.items.length > PAGE)
    throw new SchemaError(`Goldman Sachs returned ${search.items.length} rows for a ${PAGE} page`);
  return { total, hasNext, items: search.items as JsonObject[] };
}

/** The numeric requisition id the role page URL uses. */
function sourceIdOf(role: JsonObject): string {
  const id = str(obj(role.externalSource).sourceId);
  if (!id || !/^\d{1,20}$/.test(id))
    throw new SchemaError("Goldman Sachs role without a numeric externalSource.sourceId");
  return id;
}

const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const stated = (value: unknown): Json | undefined =>
  value === null || value === undefined || value === "" ? undefined : (value as Json);

function pay(value: unknown): Money[] {
  const c = obj(value);
  const min = num(c.minSalary);
  const max = num(c.maxSalary);
  if (min === undefined && max === undefined) return [];
  // The gateway names no interval for a salary range, so none is assumed.
  return [
    {
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(str(c.currency) ? { currency: str(c.currency) } : {}),
      interval: "unknown",
      component: "base",
    },
  ];
}

export const goldman: Platform = {
  id: "goldman",
  version: 1,
  hosts: ["api-higher.gs.com"],
  validate(source) {
    if (source.key !== "goldmansachs")
      throw new Error(`Goldman Sachs source key must be goldmansachs: ${source.key}`);
  },

  async *list(_source, ctx) {
    const seen = new Set<string>();
    let total: number | undefined;
    let complete = true;
    for (let pageNumber = 0; ; pageNumber++) {
      const page = pageOf((await ctx.http.postJson(API, requestBody(pageNumber))).data);
      if (total === undefined) total = page.total;
      else if (page.total !== total) {
        complete = false;
        ctx.record({
          code: "pagination",
          message: `Goldman Sachs total changed from ${total} to ${page.total} at page ${pageNumber}`,
        });
        total = page.total;
      }
      let fresh = 0;
      for (const role of page.items) {
        const id = sourceIdOf(role);
        if (seen.has(id)) {
          complete = false;
          ctx.record({
            code: "pagination",
            message: `Goldman Sachs repeated role ${id} at page ${pageNumber}`,
          });
          continue;
        }
        seen.add(id);
        fresh++;
        yield { id, listing: role } satisfies RawPosting;
        if (seen.size >= ctx.maxPostings) {
          ctx.record({ code: "budget", message: `Stopped at ${ctx.maxPostings} postings` });
          return { complete: false, emptyIsAuthoritative: false };
        }
      }
      if (!page.hasNext) break;
      if (fresh === 0) {
        complete = false;
        ctx.record({
          code: "pagination",
          message: `Goldman Sachs page ${pageNumber} brought no new role but reported a next page`,
        });
        break;
      }
    }
    if (seen.size !== total) {
      complete = false;
      ctx.record({
        code: "pagination",
        message: `Goldman Sachs listing saw ${seen.size} of ${total} reported roles`,
      });
    }
    return { complete, emptyIsAuthoritative: total === 0 };
  },

  /** `createdDate` is the moment the gateway last refreshed its copy, not a property of the role. */
  fingerprint: (listing) => {
    const { createdDate, ...stable } = obj(listing);
    return stable;
  },

  map({ id: postingId, listing }) {
    const j = lookup(listing);
    const source = obj(j("externalSource"));
    const places = arr(j("locations")).map(obj);
    const primaryFirst = [...places].sort(
      (a, b) => Number(b.primary === true) - Number(a.primary === true),
    );
    const extras: JsonObject = {};
    const put = (key: string, value: Json | undefined) => {
      if (value !== undefined) extras[key] = value;
    };
    put("corporateTitle", stated(j("corporateTitle")));
    put("shortDescription", stated(j("shortDescription")));
    put("skills", arr(j("skills")).length > 0 ? arr(j("skills")) : undefined);
    put("skillset", stated(j("skillset")));
    put("roleId", stated(j("roleId")));
    put("status", stated(j("status")));
    put("externalJobStatus", stated(j("externalJobStatus")));
    put("applicationFlowId", stated(j("applicationFlowId")));
    put("externalSourceType", stated(source.externalSourceType));
    put("secondarySourceId", stated(source.secondarySourceId));
    put("educationLevel", stated(j("educationLevel")));
    put("gradDegreeStartDate", stated(j("gradDegreeStartDate")));
    put("gradDegreeEndDate", stated(j("gradDegreeEndDate")));
    put("startDate", stated(j("startDate")));
    put("endDate", stated(j("endDate")));
    put("jobTypeCode", stated(obj(j("jobType")).code));
    const url = `https://higher.gs.com/roles/${postingId}`;
    return {
      postingId,
      title: str(j("jobTitle")) ?? "",
      url,
      applyUrl: url,
      description: describe(j("descriptionHtml") ?? j("shortDescription")),
      locations: locations(
        primaryFirst.map((place) => {
          const [city, state, country] = [str(place.city), str(place.state), str(place.country)];
          return {
            text: [city, state, country].filter(Boolean).join(", "),
            hints: { city, region: state, country },
          };
        }),
      ),
      department: str(j("division")),
      team: str(j("jobFunction")),
      employmentType: str(obj(j("jobType")).description),
      requisitionId: str(source.sourceId),
      postedAt: str(j("lastPostedDate")),
      updatedAt: str(j("lastModifiedDate")),
      compensation: pay(j("compensation")),
      experience: [],
      extras,
    };
  },
};
