import type {
  CollectContext,
  Json,
  JsonObject,
  Platform,
  RawPosting,
  SourceConfig,
} from "@tallo/contracts";
import { arr, isObject, num, obj, str } from "@tallo/contracts";
import { describe, locations, rows, SchemaError, workModeOf } from "../kit.ts";

/** Workday rejects any larger `limit` with HTTP 400 (checked live: 21, 50, 100, 200, 2000). */
const PAGE = 20;
/**
 * Some boards answer only the first 2,000 results of a query: offset 2000 and beyond wrap to the first
 * page and report total 2000. Others page past it. Either way the slice is split by facet at the cap.
 */
const CAP = 2000;

type Applied = Record<string, string[]>;
interface Leaf {
  param: string;
  id: string;
  count: number;
}
interface State {
  /** False once a real gap is known: a short page, an unsplittable capped slice, or a count mismatch. */
  complete: boolean;
  /** Distinct rows without an externalPath, keyed by their content. They have no id to close on. */
  unidentified: Set<string>;
}

const parts = (s: SourceConfig) => {
  const [tenant, site] = s.key.split("/");
  const wd = String(s.params.wd ?? "");
  if (!tenant || !site || !/^wd\d+$/.test(wd))
    throw new Error(`Workday key must be "tenant/site" with params.wd: ${s.key}`);
  return {
    tenant,
    site,
    wd,
    api: `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`,
  };
};

/** Facet values, flattened across nested groups. A group carries its own `facetParameter`. */
function leaves(facet: JsonObject, param = str(facet.facetParameter) ?? ""): Leaf[] {
  return arr(facet.values).flatMap((v): Leaf[] => {
    const value = obj(v);
    if (Array.isArray(value.values)) return leaves(value, str(value.facetParameter) ?? param);
    const leafId = str(value.id);
    return leafId ? [{ param, id: leafId, count: num(value.count) ?? 0 }] : [];
  });
}

/** The unapplied facet that covers the most jobs, split into the most pieces. */
function bestSplit(facets: Json, applied: Applied): Leaf[] | undefined {
  const options = arr(facets)
    .filter(isObject)
    .map((f) => leaves(f).filter((l) => !applied[l.param]))
    .filter((l) => l.length > 1);
  const coverage = (l: Leaf[]) => l.reduce((n, x) => n + x.count, 0);
  return options.sort((a, b) => coverage(b) - coverage(a) || b.length - a.length)[0];
}

/**
 * One POST. A rejection on the very first request means the board is not served where the config
 * says (422: the tenant is unknown on this host; 403: the career site refuses the public listing).
 * Those are failed runs with a readable message. They never imply closure.
 */
async function postPage(
  ctx: CollectContext,
  key: string,
  url: string,
  body: Json,
  first: boolean,
): Promise<Json> {
  try {
    return (await ctx.http.postJson(url, body)).data;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (first && status === 422)
      throw new Error(
        `Workday ${key} answered HTTP 422 on the first request: the tenant is not served on this params.wd host`,
      );
    if (first && status === 403)
      throw new Error(
        `Workday ${key} answered HTTP 403 (permission denied) on the first request: the career site refuses the public listing`,
      );
    throw error;
  }
}

/**
 * One query slice, paged to its end. `covered` collects every posting this slice (or the slices it split
 * into) listed, whether or not another slice already yielded it.
 *
 * A slice that reports the cap is split by facet right after its first page: the children overlap the
 * remaining 99 pages of the parent, so those are skipped. The parent's own pages are fetched only when
 * the children did not cover at least the first CAP rows, which proves they left something out.
 */
async function* slice(
  source: SourceConfig,
  ctx: CollectContext,
  applied: Applied,
  seen: Set<string>,
  state: State,
  covered: Set<string>,
): AsyncGenerator<RawPosting, number> {
  const { api, tenant, site, wd } = parts(source);
  const root = Object.keys(applied).length === 0;
  let facets: Json = [];
  let total = Number.POSITIVE_INFINITY;
  let split = false;
  const splitBy = async function* (leaves: Leaf[]) {
    split = true;
    for (const leaf of leaves) {
      const child = new Set<string>();
      yield* slice(source, ctx, { ...applied, [leaf.param]: [leaf.id] }, seen, state, child);
      for (const path of child) covered.add(path);
    }
  };
  for (let offset = 0; offset < Math.min(total, CAP); offset += PAGE) {
    const data = await postPage(
      ctx,
      `${tenant}/${site} (${wd})`,
      `${api}/jobs`,
      { appliedFacets: applied, limit: PAGE, offset, searchText: "" },
      root && offset === 0,
    );
    const body = obj(data);
    const page = rows(body.jobPostings, "jobPostings");
    const reportedTotal = body.total;
    if (
      typeof reportedTotal !== "number" ||
      !Number.isSafeInteger(reportedTotal) ||
      reportedTotal < 0
    )
      throw new SchemaError("Workday response without a nonnegative integer total");
    total = offset === 0 ? reportedTotal : Math.max(total, reportedTotal);
    if (offset === 0) facets = body.facets ?? [];
    for (const job of page) {
      const path = str(job.externalPath);
      if (!path) {
        // No id, so no catalog row can exist for it: skipping it cannot close anything. It is
        // reported once and does not make the listing incomplete (see `list`, which still counts it).
        const content = JSON.stringify(job);
        if (!state.unidentified.has(content)) {
          state.unidentified.add(content);
          ctx.record({ code: "schema", message: "Workday posting without externalPath skipped" });
        }
        continue;
      }
      covered.add(path);
      if (seen.has(path)) continue;
      seen.add(path);
      yield { id: path, listing: job };
    }
    if (offset === 0 && total >= CAP) {
      const leaves = bestSplit(facets, applied);
      if (leaves) {
        yield* splitBy(leaves);
        if (covered.size >= CAP) return total;
      }
    }
    if (page.length < PAGE) {
      if (offset + page.length < total) {
        state.complete = false;
        ctx.record({
          code: "pagination",
          message: `Workday short page at offset ${offset}: received ${page.length} of ${total} jobs`,
        });
      }
      break;
    }
  }
  if (total < CAP || split) return total;
  // Capped after the first page (the total grew while paging): partition by a facet and recurse.
  const leaves = bestSplit(facets, applied);
  if (!leaves) {
    state.complete = false;
    ctx.record({
      code: "pagination",
      message: `Workday slice over ${CAP} jobs cannot be split further`,
    });
    return total;
  }
  yield* splitBy(leaves);
  return total;
}

export const workday: Platform = {
  id: "workday",
  version: 5,
  hosts: ["*.myworkdayjobs.com"],
  validate: (source) => void parts(source),

  async *list(source, ctx) {
    const state: State = { complete: true, unidentified: new Set() };
    const seen = new Set<string>();
    const total = yield* slice(source, ctx, {}, seen, state, new Set());
    // Every row the board reported is either a listed posting or an unidentified row. Only a
    // shortfall beyond both is a real gap.
    const accounted = seen.size + state.unidentified.size;
    if (state.complete && accounted < total) {
      state.complete = false;
      ctx.record({
        code: "pagination",
        message: `Workday listing has ${accounted} jobs, fewer than reported ${total}`,
      });
    }
    return { complete: state.complete, emptyIsAuthoritative: false };
  },

  async detail(source, posting, ctx) {
    if (!posting.id.startsWith("/job/"))
      throw new SchemaError(`Unexpected Workday path: ${posting.id}`);
    return (await ctx.http.getJson(`${parts(source).api}${posting.id}`)).data;
  },

  /** "Posted 3 Days Ago" changes daily; every other listing field is stable. */
  fingerprint: (listing) => {
    const { postedOn: _ignored, ...stable } = obj(listing);
    return stable;
  },

  map({ id: postingId, listing, detail }) {
    const info = obj(obj(detail).jobPostingInfo);
    const org = obj(obj(detail).hiringOrganization);
    const l = obj(listing);
    const country = str(obj(info.country).descriptor);
    // The requisition location states an ISO alpha-2 code. It describes the primary place only.
    const alpha2 = str(obj(obj(info.jobRequisitionLocation).country).alpha2Code);
    const extra = arr(info.additionalLocations).map((text) => ({ text, hints: { country } }));
    return {
      postingId,
      title: str(info.title) ?? str(l.title) ?? "",
      url: str(info.externalUrl),
      applyUrl: str(info.externalUrl),
      description: describe(info.jobDescription),
      locations: locations([
        { text: info.location ?? l.locationsText, hints: { country, countryCode: alpha2 } },
        ...extra,
      ]),
      // Tenants that state it use "Remote", "Hybrid", "On-Site" or "In Office"; any other wording stays unknown.
      workMode: workModeOf(info.remoteType),
      employmentType: str(info.timeType),
      requisitionId: str(info.jobReqId) ?? str(arr(l.bulletFields)[0]),
      postedAt: str(info.startDate),
      expiresAt: str(info.endDate),
      compensation: [],
      experience: [],
      extras: {
        remoteType: str(info.remoteType) ?? null,
        organization: str(org.name) ?? null,
      },
    };
  },
};
