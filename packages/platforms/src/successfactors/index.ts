import type { Json, JsonObject, Platform, RawPosting } from "@tallo/contracts";
import { obj, str } from "@tallo/contracts";
import { parse } from "node-html-parser";
import {
  captureGroups,
  describe,
  locations,
  lookup,
  PostingGone,
  SchemaError,
  stated,
  uniqueWithinBudget,
} from "../kit.ts";

/**
 * SAP SuccessFactors career sites built with the Career Site Builder (the `rmkcdn.successfactors.com` pages).
 * robots.txt on these sites disallows only the apply, talent-community and service paths, so this reads what it
 * allows: the site's own `/sitemap.xml` (an XML urlset, or an RSS feed on some sites) lists every posting as
 * `/[tenant/]job/<slug>/<id>/`, and each job page carries the posting as schema.org microdata
 * (`itemtype=".../JobPosting"`) plus the site's labelled fields (`data-careersite-propertyid`).
 *
 * Source key = the site host, from a reviewed list: a new site means a new entry here after its robots.txt and
 * sitemap were read. The listing carries only ids and urls, so a changed posting is not re-fetched until
 * `version` is bumped.
 */
const HOSTS = [
  "careers.jetblue.com",
  "jobs.nexteraenergy.com",
  "jobs.exxonmobil.com",
  "jobs.deere.com",
];

const JOB_URL =
  /<(?:loc|link)>\s*(https:\/\/([^/<\s]+)\/(?:[^<\s]*\/)?job\/[^<\s]*?\/(\d{4,18}))\/?\s*<\/(?:loc|link)>/g;

const decode = (url: string) => url.replaceAll("&amp;", "&");

/** The posting's microdata and labelled fields, as the page states them. */
function parseJobPage(html: string, origin: string): JsonObject {
  const root = parse(html);
  // The microdata root, or the whole page when its wrapper did not survive parsing but the posting's own fields did.
  const posting =
    root.querySelector('[itemtype$="schema.org/JobPosting"]') ??
    (root.querySelector('[itemprop="title"]') ? root : undefined);
  if (!posting) throw new SchemaError("SuccessFactors job page without JobPosting microdata");
  const meta = (name: string) =>
    stated(posting.querySelector(`meta[itemprop="${name}"]`)?.getAttribute("content"));
  const properties: JsonObject = {};
  for (const el of posting.querySelectorAll("[data-careersite-propertyid]")) {
    const key = el.getAttribute("data-careersite-propertyid");
    const value = stated(el.text.replace(/\s+/g, " ").trim());
    if (key && value && key !== "title" && key !== "description" && !(key in properties))
      properties[key] = value;
  }
  const apply = posting.querySelector("a.apply")?.getAttribute("href");
  return {
    title: stated(posting.querySelector('[itemprop="title"]')?.text.trim()) ?? null,
    descriptionHtml: posting.querySelector('[itemprop="description"]')?.innerHTML ?? null,
    datePosted: meta("datePosted") ?? null,
    organization: meta("hiringOrganization") ?? null,
    address: {
      city: meta("addressLocality") ?? null,
      region: meta("addressRegion") ?? null,
      postalCode: meta("postalCode") ?? null,
      country: meta("addressCountry") ?? null,
    },
    applyUrl: apply ? new URL(apply, origin).href : null,
    properties,
  };
}

/** The date the page states ("Thu Oct 29 07:00:00 UTC 2026") as an ISO instant; undefined when it is not one. */
function isoDate(value: unknown): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** The postings a sitemap or feed lists for `host`, with the page url the site gave. */
function* sitemapPostings(xml: string, host: string): Generator<RawPosting> {
  for (const [url = "", siteHost = "", id = ""] of captureGroups(JOB_URL, xml)) {
    if (siteHost === host) yield { id, listing: { id, url: decode(url) } };
  }
}

export const successfactors: Platform = {
  id: "successfactors",
  version: 1,
  hosts: HOSTS,
  validate(source) {
    if (!HOSTS.includes(source.key))
      throw new Error(`Unknown SuccessFactors site: ${source.key} (one of ${HOSTS.join(", ")})`);
  },

  async *list(source, ctx) {
    const xml = (await ctx.http.getText(`https://${source.key}/sitemap.xml`)).data;
    if (!xml.includes("<urlset") && !xml.includes("<rss"))
      throw new SchemaError("SuccessFactors sitemap is neither a urlset nor an RSS feed");
    // The sitemap was read to its end (a failed read throws); an empty one proves nothing.
    const { complete } = yield* uniqueWithinBudget(sitemapPostings(xml, source.key), ctx);
    return { complete, emptyIsAuthoritative: false };
  },

  async detail(source, posting, ctx) {
    const url = str(obj(posting.listing).url);
    if (!url) throw new SchemaError("SuccessFactors listing without url");
    try {
      return parseJobPage((await ctx.http.getText(url)).data, `https://${source.key}`);
    } catch (error) {
      // A closed requisition is a 404, or a page without the posting, while the sitemap may still list it.
      if ((error as { status?: unknown } | null)?.status === 404)
        throw new PostingGone(`SuccessFactors job ${posting.id} is gone (404)`);
      if (error instanceof SchemaError)
        throw new PostingGone(`SuccessFactors job ${posting.id} has no posting on its page`);
      throw error;
    }
  },

  map({ id: postingId, listing, detail }) {
    const page = lookup(detail);
    const address = lookup(page("address"));
    const properties = lookup(page("properties"));
    const postedAt = isoDate(page("datePosted"));
    const extras: JsonObject = {};
    const put = (key: string, value: Json | undefined) => {
      if (value !== undefined) extras[key] = value;
    };
    put("organization", stated(page("organization")));
    put("properties", page("properties") as Json | undefined);
    if (postedAt === undefined) put("datePosted", stated(page("datePosted")));
    const [city, region, country] = [
      stated(address("city")),
      stated(address("region")),
      stated(address("country")),
    ];
    return {
      postingId,
      title: str(page("title")) ?? "",
      url: str(lookup(listing)("url")),
      applyUrl: str(page("applyUrl")),
      description: describe(page("descriptionHtml")),
      locations: locations([
        {
          text: [city, region, country].filter(Boolean).join(", "),
          hints: { city, region, country },
        },
      ]),
      department: stated(properties("department")),
      postedAt,
      compensation: [],
      experience: [],
      extras,
    };
  },
};
