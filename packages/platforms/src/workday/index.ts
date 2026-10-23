import type {
  CollectContext,
  Json,
  JsonObject,
  Platform,
  RawPosting,
  SourceConfig,
} from "@tallo/contracts";
import { arr, isObject, num, obj, str } from "@tallo/contracts";
import { describe, locations, rows, SchemaError } from "../kit.ts";

const PAGE = 20;
/** Workday serves at most 2000 results per query, however large the board is. */
const CAP = 2000;

type Applied = Record<string, string[]>;
interface Leaf {
  param: string;
  id: string;
  count: number;
}

const parts = (s: SourceConfig) => {
  const [tenant, site] = s.key.split("/");
  const wd = String(s.params.wd ?? "");
  if (!tenant || !site || !/^wd\d+$/.test(wd))
    throw new Error(`Workday key must be "tenant/site" with params.wd: ${s.key}`);
  return {
    tenant,
    site,
    origin: `https://${tenant}.${wd}.myworkdayjobs.com`,
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

async function* slice(
  source: SourceConfig,
  ctx: CollectContext,
  applied: Applied,
  seen: Set<string>,
  state: { complete: boolean },
): AsyncGenerator<RawPosting> {
  const { api } = parts(source);
  let facets: Json = [];
  let total = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < Math.min(total, CAP); offset += PAGE) {
    const { data } = await ctx.http.postJson(`${api}/jobs`, {
      appliedFacets: applied,
      limit: PAGE,
      offset,
      searchText: "",
    });
    const body = obj(data);
    const page = rows(body.jobPostings, "jobPostings");
    if (offset === 0) {
      total = num(body.total) ?? page.length;
      facets = body.facets ?? [];
    }
    for (const job of page) {
      const path = str(job.externalPath);
      if (!path) throw new SchemaError("Workday posting without externalPath");
      if (seen.has(path)) continue;
      seen.add(path);
      yield { id: path, listing: job };
    }
    if (page.length < PAGE) break;
  }
  if (total < CAP) return;
  // Capped: partition by a facet and recurse. Overlap is removed by `seen`.
  const split = bestSplit(facets, applied);
  if (!split) {
    state.complete = false;
    ctx.record({
      code: "pagination",
      message: `Workday slice over ${CAP} jobs cannot be split further`,
    });
    return;
  }
  for (const leaf of split) {
    yield* slice(source, ctx, { ...applied, [leaf.param]: [leaf.id] }, seen, state);
  }
}

export const workday: Platform = {
  id: "workday",
  version: 1,
  hosts: ["*.myworkdayjobs.com"],
  validate: (source) => void parts(source),

  async *list(source, ctx) {
    const state = { complete: true };
    yield* slice(source, ctx, {}, new Set(), state);
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
    const l = obj(listing);
    const country = str(obj(info.country).descriptor);
    const extra = arr(info.additionalLocations).map((text) => ({ text, hints: { country } }));
    return {
      postingId,
      title: str(info.title) ?? str(l.title) ?? "",
      url: str(info.externalUrl),
      applyUrl: str(info.externalUrl),
      description: describe(info.jobDescription),
      locations: locations([
        { text: info.location ?? l.locationsText, hints: { country } },
        ...extra,
      ]),
      employmentType: str(info.timeType),
      requisitionId: str(info.jobReqId) ?? str(arr(l.bulletFields)[0]),
      postedAt: str(info.startDate),
      expiresAt: str(info.endDate),
      compensation: [],
      experience: [],
      extras: {
        ...(str(info.remoteType) ? { remoteType: str(info.remoteType) } : {}),
        ...(str(obj(obj(detail).hiringOrganization).name)
          ? { organization: str(obj(obj(detail).hiringOrganization).name) }
          : {}),
      },
    };
  },
};
