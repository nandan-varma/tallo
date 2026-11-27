import type {
  CollectContext,
  Json,
  JsonObject,
  Listing,
  Platform,
  RawPosting,
  SourceConfig,
} from "@tallo/contracts";
import { arr, obj, str } from "@tallo/contracts";
import { parse } from "node-html-parser";
import {
  captureGroups,
  describe,
  jobPostingLd,
  locations,
  lookup,
  SchemaError,
  stated,
  uniqueWithinBudget,
} from "../kit.ts";

/**
 * Radancy TalentBrew career sites (`www.att.jobs`, `jobs.walgreens.com`). Their search pages (`/search-jobs/`)
 * are disallowed by robots.txt, so this reads only what robots allows: the sitemap lists every posting page
 * (`/[lang/]job/<city>/<slug>/<org>/<id>`; its `lastmod` is the sitemap's build time, so it is not kept) and each
 * page carries a schema.org `JobPosting` JSON-LD plus the employer's apply link.
 *
 * Source key = the site host. The sitemap path defaults to `/sitemap.xml`; a site that moves it says so in
 * `params.sitemapPath` (Walgreens: `/en/sitemap.xml`). The listing carries only ids and urls, so a changed
 * posting is not re-fetched until `version` is bumped.
 *
 * A site that holds more than 500 postings and whose robots.txt allows its search (Walgreens, ~22,000) says
 * `params.searchPath` (`/en/search-jobs/results`, TalentBrew's own JSON results endpoint) and is listed from
 * there instead: 100 ids per request, at most 100 pages (10,000 results) per query, so a query over the cap is
 * split by facet (country, then state) and the union is complete only when it reaches the site's own total.
 */
const HOSTS = [
  "www.att.jobs",
  "jobs.walgreens.com",
  "www.kaiserpermanentejobs.org",
  "www.schwabjobs.com",
  "careers.unitedhealthgroup.com",
  "careers.l3harris.com",
  "careers.synopsys.com",
  "careers.netapp.com",
];
/** A TalentBrew sitemap lists at most 500 postings; a full one is a truncated listing, never a complete one. */
const SITEMAP_CAP = 500;
const PATH = /^\/[A-Za-z0-9/_.-]*\.xml$/;
const SEARCH_PATH = /^\/[a-z]{2}\/search-jobs\/results$/;
/** The search endpoint answers at most 100 pages of 100 results per query. */
const SEARCH_PAGE = 100;
const SEARCH_CAP = 100 * SEARCH_PAGE;
const RESULT_URL = /href="(\/(?:[a-z]{2}\/)?job\/[^"\s]+\/(\d{1,15}))"/g;
const FACET = /data-facet-type="([23])" data-id="([^"]+)" data-count="(\d+)"/g;
const JOB_URL = /<loc>(https:\/\/[^<\s/]+\/(?:[a-z]{2}\/)?job\/[^<\s]+\/(\d{1,15}))<\/loc>/g;

const sitemapPath = (params: Record<string, unknown>) =>
  typeof params.sitemapPath === "string" ? params.sitemapPath : "/sitemap.xml";

const searchPath = (params: Record<string, unknown>) =>
  typeof params.searchPath === "string" ? params.searchPath : undefined;

interface Facet {
  /** 2: country, 3: state (its id is `<country id>-<state id>`). */
  type: string;
  id: string;
  count: number;
}

/** One results query: the whole site, or one applied facet. */
function searchUrl(
  source: SourceConfig,
  path: string,
  page: number,
  facet?: Facet,
  filters = false,
) {
  const q = new URLSearchParams({
    ActiveFacetID: facet?.id ?? "0",
    CurrentPage: String(page),
    RecordsPerPage: String(SEARCH_PAGE),
    Distance: "50",
    RadiusUnitType: "0",
    SearchResultsModuleName: "Search Results",
    SortCriteria: "0",
    SortDirection: "0",
    SearchType: "5",
  });
  // The facet lists are about 5 MB; only the one request that reads them asks for them.
  if (filters) {
    q.set("IsPagination", "False");
    q.set("SearchFiltersModuleName", "Search Filters");
  }
  if (facet) {
    q.set("FacetFilters[0].ID", facet.id);
    q.set("FacetFilters[0].FacetType", facet.type);
    q.set("FacetFilters[0].IsApplied", "true");
  }
  return `https://${source.key}${path}?${q}`;
}

function resultsOf(data: unknown): { html: string; filters: string } {
  const body = obj(data);
  const html = str(body.results);
  if (html === undefined || !html.includes('id="search-results"'))
    throw new SchemaError("Radancy search response without results");
  return { html, filters: str(body.filters) ?? "" };
}

/** The page's JobPosting JSON-LD and the employer's apply link. */
function parseJobPage(html: string): JsonObject {
  const root = parse(html);
  const ld = jobPostingLd(root);
  if (!ld) throw new SchemaError("Radancy job page without JobPosting JSON-LD");
  const applyUrl = root.querySelector("a.job-apply")?.getAttribute("data-apply-url");
  return { jsonLd: ld, applyUrl: applyUrl ?? null };
}

/** Every job of the search endpoint, split by facet when the site holds more than one query can page. */
async function* listSearch(
  source: SourceConfig,
  path: string,
  ctx: CollectContext,
): AsyncGenerator<RawPosting, Listing> {
  const seen = new Set<string>();
  let overCap = false;
  /** Pages one query to its end; returns the site-reported total of that query. */
  async function* page(facet?: Facet, total?: number): AsyncGenerator<RawPosting, number> {
    for (let n = 1; n <= SEARCH_PAGE; n++) {
      const { html } = resultsOf((await ctx.http.getJson(searchUrl(source, path, n, facet))).data);
      total ??= Number(/data-total-results="(\d+)"/.exec(html)?.[1]);
      let rows = 0;
      for (const match of html.matchAll(RESULT_URL)) {
        const [, href, id] = match as unknown as [string, string, string];
        rows++;
        if (seen.has(id)) continue;
        seen.add(id);
        yield { id, listing: { id, url: `https://${source.key}${href}` } } satisfies RawPosting;
        if (seen.size >= ctx.maxPostings) return total;
      }
      if (rows < SEARCH_PAGE) return total;
    }
    overCap = true;
    return total ?? 0;
  }
  const { filters, html } = resultsOf(
    (await ctx.http.getJson(searchUrl(source, path, 1, undefined, true))).data,
  );
  const total = Number(/data-total-results="(\d+)"/.exec(html)?.[1]);
  if (!Number.isFinite(total)) throw new SchemaError("Radancy search response without a total");
  const facets = [...filters.matchAll(FACET)].map(
    (m) => ({ type: m[1], id: m[2], count: Number(m[3]) }) as Facet,
  );
  const queries: (Facet | undefined)[] = [];
  if (total <= SEARCH_CAP) queries.push(undefined);
  else
    for (const country of facets.filter((f) => f.type === "2"))
      if (country.count <= SEARCH_CAP) queries.push(country);
      else
        queries.push(...facets.filter((f) => f.type === "3" && f.id.startsWith(`${country.id}-`)));
  for (const facet of queries) {
    if (facet && facet.count > SEARCH_CAP) overCap = true;
    yield* page(facet);
    if (seen.size >= ctx.maxPostings) {
      ctx.record({ code: "budget", message: `Stopped at ${ctx.maxPostings} postings` });
      return { complete: false, emptyIsAuthoritative: false };
    }
  }
  // The split is complete only when it reaches every posting the site counts (a posting without a
  // country, or one added mid-listing, shows up as a shortfall).
  const complete = !overCap && seen.size >= total;
  if (!complete)
    ctx.record({
      code: "pagination",
      message: `Search listing holds ${seen.size} of ${total} postings; it is truncated`,
    });
  return { complete, emptyIsAuthoritative: false };
}

/** The postings a sitemap lists for `host`. */
function* sitemapPostings(xml: string, host: string): Generator<RawPosting> {
  for (const [url = "", id = ""] of captureGroups(JOB_URL, xml)) {
    if (new URL(url).host === host) yield { id, listing: { id, url } };
  }
}

export const radancy: Platform = {
  id: "radancy",
  version: 1,
  hosts: HOSTS,
  validate(source) {
    if (!HOSTS.includes(source.key)) throw new Error(`Unknown Radancy host: ${source.key}`);
    if (!PATH.test(sitemapPath(source.params)))
      throw new Error(`Invalid Radancy sitemapPath for ${source.key}`);
    const search = searchPath(source.params);
    if (search !== undefined && !SEARCH_PATH.test(search))
      throw new Error(`Invalid Radancy searchPath for ${source.key}`);
  },

  async *list(source, ctx) {
    const search = searchPath(source.params);
    if (search) return yield* listSearch(source, search, ctx);
    const xml = (await ctx.http.getText(`https://${source.key}${sitemapPath(source.params)}`)).data;
    if (!xml.includes("<urlset")) throw new SchemaError("Radancy sitemap is not a urlset");
    const { complete: whole, listed } = yield* uniqueWithinBudget(
      sitemapPostings(xml, source.key),
      ctx,
    );
    if (!whole) return { complete: false, emptyIsAuthoritative: false };
    const truncated = listed >= SITEMAP_CAP;
    if (truncated)
      ctx.record({
        code: "pagination",
        message: `Sitemap holds ${listed} postings, the TalentBrew cap; the listing is truncated`,
      });
    // The sitemap is a snapshot; an empty one proves nothing.
    return { complete: !truncated, emptyIsAuthoritative: false };
  },

  async detail(_source, posting, ctx) {
    const url = str(obj(posting.listing).url);
    if (!url) throw new SchemaError("Radancy listing without url");
    return parseJobPage((await ctx.http.getText(url)).data);
  },

  map({ id: postingId, listing, detail }) {
    const page = lookup(detail);
    const ld = lookup(page("jsonLd"));
    const org = lookup(ld("hiringOrganization"));
    const ids = lookup(ld("identifier"));
    const extras: JsonObject = {};
    const put = (key: string, value: Json | undefined) => {
      if (value !== undefined) extras[key] = value;
    };
    put("industry", stated(ld("industry")));
    put("organization", stated(org("name")));
    put("directApply", ld("directApply"));
    put("qualifications", stated(ld("qualifications")));
    put("responsibilities", stated(ld("responsibilities")));
    put("skills", stated(ld("skills")));
    return {
      postingId,
      title: str(ld("title")) ?? "",
      url: str(ld("url")) ?? str(lookup(listing)("url")),
      applyUrl: str(page("applyUrl")),
      description: describe(ld("description")),
      locations: locations(
        arr(ld("jobLocation")).map((place) => {
          const address = obj(obj(place).address);
          const [city, region, country] = [
            stated(address.addressLocality),
            stated(address.addressRegion),
            stated(address.addressCountry),
          ];
          return {
            text: [city, region, country].filter(Boolean).join(", "),
            hints: { city, region, country },
          };
        }),
      ),
      employmentType: stated(ld("employmentType")),
      requisitionId: stated(ids("value")),
      postedAt: stated(ld("datePosted")),
      expiresAt: stated(ld("validThrough")),
      compensation: [],
      experience: [],
      extras,
    };
  },
};
