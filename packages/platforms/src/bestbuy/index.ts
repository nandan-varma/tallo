import type { Json, Money, Platform, RawPosting } from "@tallo/contracts";
import { arr, obj, str } from "@tallo/contracts";
import { definedOnly, describe, locations, lookup, PostingGone, SchemaError } from "../kit.ts";

/**
 * Best Buy careers (`jobs.bestbuy.com/bby`), a ServiceNow Service Portal that renders in the browser.
 * robots.txt allows everything and names the sitemap (`bestbuy.service-now.com/api/93622/seo/sitemap`), which
 * lists every posting page (`/bby?id=job_details&req_id=<id>`) with a `lastmod`; it held 1,424 postings on
 * 2026-11-22, the same count the portal's own search reports. The portal fills a job page from
 * `GET /api/now/sp/page?id=job_details&req_id=<id>`, which answers anonymously without a session; its
 * `job_details` widget carries the posting under `data.job`. The widget's search call needs a session cookie and
 * token, which the collector's `Http` cannot carry, so the sitemap is the listing.
 *
 * Source key = `jobs.bestbuy.com`. A requisition that is gone answers 200 with an empty `job`.
 */
const HOST = "jobs.bestbuy.com";
const HOSTS = [HOST, "bestbuy.service-now.com"];
const SITEMAP = "https://bestbuy.service-now.com/api/93622/seo/sitemap";
const PORTAL = "c5f6902e1b91b850b4c011f18c4bcbf5";
const JOB_URL =
  /<loc>https:\/\/jobs\.bestbuy\.com\/bby\?id=job_details&amp;req_id=([A-Za-z0-9_-]{1,40})<\/loc>(?:\s*<lastmod>([^<]*)<\/lastmod>)?/g;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const stated = (value: unknown): string | undefined => str(value) || undefined;
const pageUrl = (id: string) =>
  `https://${HOST}/bby?id=job_details&req_id=${encodeURIComponent(id)}`;

/** `21-Nov-2026` as the ISO date the source states; anything else is not a date we know. */
function isoDate(value: unknown): string | undefined {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(str(value) ?? "");
  const month = MONTHS.indexOf(match?.[2] ?? "");
  if (!match || month < 0) return undefined;
  return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1]?.padStart(2, "0")}`;
}

/** The `job` record of the page's job widget (`containers[0].rows[0].columns[0].widgets[0]`). */
function jobOf(page: Json): Json {
  let node: Json | undefined = obj(page).result;
  for (const key of [
    "containers",
    0,
    "rows",
    0,
    "columns",
    0,
    "widgets",
    0,
    "widget",
    "data",
    "job",
  ])
    node = typeof key === "number" ? arr(node)[key] : obj(node)[key];
  if (node === undefined) throw new SchemaError("Best Buy job page without a job widget");
  return node;
}

export const bestbuy: Platform = {
  id: "bestbuy",
  version: 1,
  hosts: HOSTS,
  validate(source) {
    if (source.key !== HOST) throw new Error(`Best Buy source key must be ${HOST}: ${source.key}`);
  },

  async *list(_source, ctx) {
    const xml = (await ctx.http.getText(SITEMAP)).data;
    if (!xml.includes("<urlset")) throw new SchemaError("Best Buy sitemap is not a urlset");
    const seen = new Set<string>();
    for (const match of xml.matchAll(JOB_URL)) {
      const [, id, lastmod] = match as unknown as [string, string, string | undefined];
      if (seen.has(id)) continue;
      seen.add(id);
      yield { id, listing: definedOnly({ id, url: pageUrl(id), lastmod }) } satisfies RawPosting;
      if (seen.size >= ctx.maxPostings) {
        ctx.record({ code: "budget", message: `Stopped at ${ctx.maxPostings} postings` });
        return { complete: false, emptyIsAuthoritative: false };
      }
    }
    // The sitemap was read to its end; an empty one proves nothing.
    return { complete: true, emptyIsAuthoritative: false };
  },

  /** Only the posting record is kept: the rest of the page response is portal chrome (menus, banners). */
  async detail(_source, posting, ctx) {
    const id = encodeURIComponent(posting.id);
    const request = encodeURIComponent(`/bby?id=job_details&req_id=${posting.id}`);
    const { data } = await ctx.http.getJson(
      `https://${HOST}/api/now/sp/page?id=job_details&req_id=${id}&portal_id=${PORTAL}&request_uri=${request}`,
    );
    const job = jobOf(data);
    if (!str(obj(job).auto_req_id)) throw new PostingGone(`Best Buy job ${posting.id} is gone`);
    return { job };
  },

  map({ id: postingId, listing, detail }) {
    const job = lookup(lookup(detail)("job"));
    const row = lookup(listing);
    const [address, city, state, country] = [
      stated(job("address")),
      stated(job("city")),
      stated(job("state")),
      stated(job("country")),
    ];
    const min = Number(job("pay_min"));
    const max = Number(job("pay_max"));
    const compensation: Money[] =
      min > 0 || max > 0
        ? [
            {
              ...(min > 0 ? { min } : {}),
              ...(max > 0 ? { max } : {}),
              currency: stated(job("pay_currency")),
              // The source states the interval only inside its range label ("$16 - $20.8 /hr").
              interval: /\/\s*hr\s*$/.test(str(job("pay_range")) ?? "") ? "hour" : "unknown",
              component: "base" as const,
            },
          ]
        : [];
    return {
      postingId,
      title: str(job("title")) ?? "",
      url: str(row("url")) ?? pageUrl(postingId),
      applyUrl: stated(job("job_link")),
      description: describe(job("job_description_dv")),
      locations: locations([
        {
          text: [address, city, state, country].filter(Boolean).join(", "),
          hints: { city, region: state, country },
        },
      ]),
      department: stated(job("category")),
      employmentType: stated(job("type")),
      requisitionId: stated(job("auto_req_id")),
      updatedAt: isoDate(job("last_updated")),
      compensation,
      experience: [],
      extras: definedOnly({
        workerType: stated(job("worker_type")),
        experienceLevel: stated(job("experience")),
        site: stated(job("job_location")),
        remoteEligible: stated(job("remote_eligible")),
      }),
    };
  },
};
