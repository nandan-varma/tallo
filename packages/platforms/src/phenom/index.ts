import type { Json, JsonObject, Platform, RawPosting, SourceConfig } from "@tallo/contracts";
import { arr, isObject, obj, str } from "@tallo/contracts";
import { parse } from "node-html-parser";
import {
  definedOnly,
  describe,
  locations,
  lookup,
  PostingGone,
  SchemaError,
  strings,
} from "../kit.ts";

/**
 * Phenom career sites. Today one site: UPS (`www.jobs-ups.com`; key = host). robots.txt of the site disallows
 * only apply, cart, chatbot and `px-widgets` paths, so the page's own search call is read: `POST /widgets`
 * (`ddoKey: "refineSearch"`, the call `/us/en/search-results` makes itself) returns the whole board in pages of
 * 100 with `totalHits`, and each job page (`/<path>/job/<jobId>`, not disallowed) carries a schema.org
 * `JobPosting` JSON-LD with the description.
 *
 * The job page also embeds the whole requisition record (`phApp.ddo.jobDetail`). It holds internal HR fields that
 * name people (the employee being replaced, the requisition justification, the supervisory org), and nothing
 * personal is stored, so the collector reads only the public JSON-LD of the page and never that record.
 *
 * The listing carries the structured facts (pay text, category, apply link, locations, posted date); the
 * description is the only reason to fetch a page. `params.path` (default `us/en`) is the site's locale path and
 * `params.lang` (default `en_us`) the widget locale; the US English site holds the whole US board.
 */
const HOSTS = ["www.jobs-ups.com"];
const PAGE = 100;
/** The widget answers nothing past this offset, so a board larger than this cannot be listed whole. */
const MAX_OFFSET = 10_000;
const PATH = /^[a-z]{2,4}\/[a-z]{2}$/;
const LANG = /^[a-z]{2}_[a-z]{2}$/;

const pathOf = (source: SourceConfig) =>
  typeof source.params.path === "string" ? source.params.path : "us/en";
const langOf = (source: SourceConfig) =>
  typeof source.params.lang === "string" ? source.params.lang : "en_us";

/** Facts the source stated; an empty string is "not stated". */
const stated = (value: unknown): string | undefined => str(value) || undefined;

/** The request body the site's own search page sends (everything but paging is its fixed default). */
const searchBody = (source: SourceConfig, from: number): Json => ({
  lang: langOf(source),
  country: pathOf(source).split("/")[0] ?? "us",
  deviceType: "desktop",
  pageName: "search-results",
  ddoKey: "refineSearch",
  pageId: "page4",
  siteType: "external",
  sortBy: "",
  subsearch: "",
  keywords: "",
  global: true,
  jobs: true,
  counts: true,
  all_fields: ["category"],
  clearAll: false,
  jdsource: "facets",
  isSliderEnable: false,
  selected_fields: {},
  locationData: {},
  from,
  size: PAGE,
});

/** The page's JobPosting JSON-LD (the only part of the page the collector keeps). */
function parseJobPage(html: string): JsonObject {
  const ld = parse(html)
    .querySelectorAll('script[type="application/ld+json"]')
    .map((s) => {
      try {
        // rawText: a script body is not entity-decoded.
        return JSON.parse(s.rawText) as Json;
      } catch {
        return undefined;
      }
    })
    .find((v) => isObject(v) && v["@type"] === "JobPosting");
  if (!ld) throw new SchemaError("Phenom job page without JobPosting JSON-LD");
  return { jsonLd: ld };
}

export const phenom: Platform = {
  id: "phenom",
  version: 1,
  hosts: HOSTS,
  validate(source) {
    if (!HOSTS.includes(source.key))
      throw new Error(`Phenom source key must be one of ${HOSTS.join(", ")}: ${source.key}`);
    if (!PATH.test(pathOf(source)))
      throw new Error(`Phenom params.path must look like us/en: ${pathOf(source)}`);
    if (!LANG.test(langOf(source)))
      throw new Error(`Phenom params.lang must look like en_us: ${langOf(source)}`);
  },

  async *list(source, ctx) {
    const seen = new Set<string>();
    let total = 0;
    for (let from = 0; ; from += PAGE) {
      if (from >= MAX_OFFSET) return { complete: false, emptyIsAuthoritative: false };
      const response = obj(
        obj(
          (await ctx.http.postJson(`https://${source.key}/widgets`, searchBody(source, from))).data,
        ).refineSearch,
      );
      const data = obj(response.data);
      if (
        response.status !== 200 ||
        !Array.isArray(data.jobs) ||
        typeof response.totalHits !== "number"
      )
        throw new SchemaError("Phenom widget answered an unexpected shape");
      total = response.totalHits;
      for (const row of data.jobs) {
        const id = str(obj(row).jobId);
        if (!id) throw new SchemaError("Phenom listing row without jobId");
        if (seen.has(id)) continue;
        seen.add(id);
        yield { id, listing: row } satisfies RawPosting;
        if (seen.size >= ctx.maxPostings) {
          ctx.record({ code: "budget", message: `Stopped at ${ctx.maxPostings} postings` });
          return { complete: false, emptyIsAuthoritative: false };
        }
      }
      if (data.jobs.length === 0 || from + data.jobs.length >= total) break;
    }
    // Every page up to `totalHits` was read; a shorter list means the board changed under the run.
    return { complete: seen.size >= total, emptyIsAuthoritative: false };
  },

  async detail(source, posting, ctx) {
    try {
      const url = `https://${source.key}/${pathOf(source)}/job/${encodeURIComponent(posting.id)}`;
      return parseJobPage((await ctx.http.getText(url)).data);
    } catch (error) {
      // A closed requisition answers 410 (404 for a mistyped id) while the widget may still list it briefly.
      const status = (error as { status?: unknown } | null)?.status;
      if (status === 404 || status === 410)
        throw new PostingGone(`Phenom job ${posting.id} is gone`);
      throw error;
    }
  },

  // `ml_*` are the site's machine-derived guesses (skills, teasers) and `badge` a UI label; none is a stated fact.
  fingerprint(listing) {
    const volatile = new Set(["ml_skills", "ml_job_parser", "badge"]);
    return Object.fromEntries(Object.entries(obj(listing)).filter(([key]) => !volatile.has(key)));
  },

  map({ id: postingId, listing, detail }, source) {
    const row = lookup(listing);
    const ld = lookup(lookup(detail)("jsonLd"));
    const places = strings(row("multi_location"));
    const single = places.length <= 1;
    const types = arr(ld("employmentType"))
      .map(stated)
      .filter((t): t is string => t !== undefined);
    // The JSON-LD description is HTML escaped once more (`&lt;p&gt;`); parsing it yields the real markup.
    const html = parse(str(ld("description")) ?? "").text;
    return {
      postingId,
      title: str(row("title")) ?? str(ld("title")) ?? "",
      url: `https://${source.key}/${pathOf(source)}/job/${encodeURIComponent(postingId)}`,
      applyUrl: stated(row("applyUrl")),
      description: describe(html),
      locations: locations(
        places.map((text) => ({
          text,
          hints: single
            ? {
                city: stated(row("city")),
                region: stated(row("state")),
                country: stated(row("country")),
              }
            : {},
        })),
      ),
      department: stated(row("category")),
      employmentType: types.length > 0 ? types.join(", ") : stated(row("type")),
      requisitionId: stated(row("reqId")),
      postedAt: stated(row("postedDate")) ?? stated(ld("datePosted")),
      compensation: [],
      experience: [],
      extras: definedOnly({
        openingPayRate: stated(row("openingPayRate")),
        bonus: stated(row("bonus")),
        contractType: stated(row("employmentType")),
        schedule: stated(row("type")),
        workHours: stated(ld("workHours")),
        directApply: ld("directApply"),
      }),
    };
  },
};
