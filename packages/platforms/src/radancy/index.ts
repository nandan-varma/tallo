import type { Json, JsonObject, Platform, RawPosting } from "@tallo/contracts";
import { arr, isObject, obj, str } from "@tallo/contracts";
import { parse } from "node-html-parser";
import { describe, locations, lookup, SchemaError } from "../kit.ts";

/**
 * Radancy TalentBrew career sites (`www.att.jobs`, `jobs.walgreens.com`). Their search pages (`/search-jobs/`)
 * are disallowed by robots.txt, so this reads only what robots allows: the sitemap lists every posting page
 * (`/[lang/]job/<city>/<slug>/<org>/<id>`; its `lastmod` is the sitemap's build time, so it is not kept) and each
 * page carries a schema.org `JobPosting` JSON-LD plus the employer's apply link.
 *
 * Source key = the site host. The sitemap path defaults to `/sitemap.xml`; a site that moves it says so in
 * `params.sitemapPath` (Walgreens: `/en/sitemap.xml`). The listing carries only ids and urls, so a changed
 * posting is not re-fetched until `version` is bumped.
 */
const HOSTS = ["www.att.jobs", "jobs.walgreens.com"];
/** A TalentBrew sitemap lists at most 500 postings; a full one is a truncated listing, never a complete one. */
const SITEMAP_CAP = 500;
const PATH = /^\/[A-Za-z0-9/_.-]*\.xml$/;
const JOB_URL = /<loc>(https:\/\/[^<\s/]+\/(?:[a-z]{2}\/)?job\/[^<\s]+\/(\d{1,15}))<\/loc>/g;

const sitemapPath = (params: Record<string, unknown>) =>
  typeof params.sitemapPath === "string" ? params.sitemapPath : "/sitemap.xml";

/** Facts the source stated; an empty string is "not stated". */
const stated = (value: unknown): string | undefined => str(value) || undefined;

/** The page's JobPosting JSON-LD and the employer's apply link. */
function parseJobPage(html: string): JsonObject {
  const root = parse(html);
  const ld = root
    .querySelectorAll('script[type="application/ld+json"]')
    .map((s) => {
      try {
        return JSON.parse(s.text) as Json;
      } catch {
        return undefined;
      }
    })
    .find((v) => isObject(v) && v["@type"] === "JobPosting");
  if (!ld) throw new SchemaError("Radancy job page without JobPosting JSON-LD");
  const applyUrl = root.querySelector("a.job-apply")?.getAttribute("data-apply-url");
  return { jsonLd: ld, applyUrl: applyUrl ?? null };
}

export const radancy: Platform = {
  id: "radancy",
  version: 1,
  hosts: HOSTS,
  validate(source) {
    if (!HOSTS.includes(source.key)) throw new Error(`Unknown Radancy host: ${source.key}`);
    if (!PATH.test(sitemapPath(source.params)))
      throw new Error(`Invalid Radancy sitemapPath for ${source.key}`);
  },

  async *list(source, ctx) {
    const xml = (await ctx.http.getText(`https://${source.key}${sitemapPath(source.params)}`)).data;
    if (!xml.includes("<urlset")) throw new SchemaError("Radancy sitemap is not a urlset");
    const seen = new Set<string>();
    for (const match of xml.matchAll(JOB_URL)) {
      const [, url, id] = match as unknown as [string, string, string];
      if (new URL(url).host !== source.key || seen.has(id)) continue;
      seen.add(id);
      yield { id, listing: { id, url } } satisfies RawPosting;
      if (seen.size >= ctx.maxPostings) {
        ctx.record({ code: "budget", message: `Stopped at ${ctx.maxPostings} postings` });
        return { complete: false, emptyIsAuthoritative: false };
      }
    }
    if (seen.size >= SITEMAP_CAP)
      ctx.record({
        code: "pagination",
        message: `Sitemap holds ${seen.size} postings, the TalentBrew cap; the listing is truncated`,
      });
    // The sitemap is a snapshot; an empty one proves nothing.
    return { complete: seen.size < SITEMAP_CAP, emptyIsAuthoritative: false };
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
