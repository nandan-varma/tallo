import type { Json, JsonObject, Platform, RawPosting } from "@tallo/contracts";
import { arr, isObject, obj, str } from "@tallo/contracts";
import { parse } from "node-html-parser";
import { describe, locations, lookup, PostingGone, SchemaError } from "../kit.ts";

/**
 * FedEx careers (`careers.fedex.com`). robots.txt allows everything and the site has no public list API, so
 * this reads the sitemaps and the job pages: each page carries a schema.org `JobPosting` JSON-LD and the
 * employer's own apply link (`a.apply-button`: a Paradox or Workday page).
 *
 * `sitemap.xml` is an index of per-locale sitemaps from two tenants. The `-en` sitemap of each tenant is the
 * canonical list: `a0a4453b` is the US and Canada board (2,980 postings, ids like `P25-394285-1`) and
 * `c84076ce` is the rest of the world (1,538 postings, hash ids). The other locale sitemaps (`fr-ca`, `de-de`,
 * `pt-br`, ...) list the same postings again in another language (checked: every `fr-ca`, `de-de` and `pt-br`
 * id is already in its tenant's `-en`), so only these two are read, as a reviewed fixed set. A new tenant means
 * a new entry here after review.
 *
 * Source key = `careers.fedex.com`. The sitemap `lastmod` equals the posting date, so it is not kept; the
 * listing carries only ids and urls, so a changed posting is not re-fetched until `version` is bumped.
 */
const HOST = "careers.fedex.com";
const SITEMAPS = ["/sitemap-a0a4453b-en.xml", "/sitemap-c84076ce-en.xml"];
const JOB_URL =
  /<loc>(https:\/\/careers\.fedex\.com\/[^<\s/]+\/job\/([A-Za-z0-9_-]{1,80}))<\/loc>/g;

/** Facts the source stated; an empty string is "not stated". */
const stated = (value: unknown): string | undefined => str(value) || undefined;

/** The page's JobPosting JSON-LD and the employer's apply link. */
function parseJobPage(html: string): JsonObject {
  const root = parse(html);
  const ld = root
    .querySelectorAll('script[type="application/ld+json"]')
    .map((s) => {
      try {
        // rawText: a script body is not entity-decoded (the page writes `&quot;` inside JSON strings).
        return JSON.parse(s.rawText) as Json;
      } catch {
        return undefined;
      }
    })
    .find((v) => isObject(v) && v["@type"] === "JobPosting");
  if (!ld) throw new SchemaError("FedEx job page without JobPosting JSON-LD");
  const applyUrl = root.querySelector("a.apply-button")?.getAttribute("href");
  return { jsonLd: ld, applyUrl: applyUrl ?? null };
}

export const fedex: Platform = {
  id: "fedex",
  version: 1,
  hosts: [HOST],
  validate(source) {
    if (source.key !== HOST) throw new Error(`FedEx source key must be ${HOST}: ${source.key}`);
  },

  async *list(_source, ctx) {
    const seen = new Set<string>();
    for (const path of SITEMAPS) {
      const xml = (await ctx.http.getText(`https://${HOST}${path}`)).data;
      if (!xml.includes("<urlset")) throw new SchemaError(`FedEx sitemap ${path} is not a urlset`);
      for (const match of xml.matchAll(JOB_URL)) {
        const [, url, id] = match as unknown as [string, string, string];
        if (seen.has(id)) continue;
        seen.add(id);
        yield { id, listing: { id, url } } satisfies RawPosting;
        if (seen.size >= ctx.maxPostings) {
          ctx.record({ code: "budget", message: `Stopped at ${ctx.maxPostings} postings` });
          return { complete: false, emptyIsAuthoritative: false };
        }
      }
    }
    // Both sitemaps were read to their end (a failed one throws); an empty answer proves nothing.
    return { complete: true, emptyIsAuthoritative: false };
  },

  async detail(_source, posting, ctx) {
    const url = str(obj(posting.listing).url);
    if (!url) throw new SchemaError("FedEx listing without url");
    try {
      return parseJobPage((await ctx.http.getText(url)).data);
    } catch (error) {
      // A closed posting is a 404 while the sitemap may still list it for a while.
      if ((error as { status?: unknown } | null)?.status === 404)
        throw new PostingGone(`FedEx job ${posting.id} is gone (404)`);
      throw error;
    }
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
    put("organization", stated(org("name")));
    put("directApply", ld("directApply"));
    const types = arr(ld("employmentType"))
      .map(stated)
      .filter((t): t is string => t !== undefined);
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
      employmentType: types.length > 0 ? types.join(", ") : stated(ld("employmentType")),
      requisitionId: stated(ids("value")),
      postedAt: stated(ld("datePosted")),
      expiresAt: stated(ld("validThrough")),
      compensation: [],
      experience: [],
      extras,
    };
  },
};
