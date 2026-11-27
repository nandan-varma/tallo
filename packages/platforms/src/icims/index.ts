import type {
  CollectContext,
  Json,
  JsonObject,
  Platform,
  RawPosting,
  SourceConfig,
} from "@tallo/contracts";
import { arr, id, num, obj, str } from "@tallo/contracts";
import { type HTMLElement, parse } from "node-html-parser";
import { describe, htmlText, jobPostingLd, locations, lookup, rows, SchemaError } from "../kit.ts";

/**
 * iCIMS career portals answer in two shapes.
 *
 * - A portal (`<key>.icims.com`, key like `careers-acme`): server-rendered HTML at
 *   `/jobs/search?pr=N&in_iframe=1` (20 cards a page) and one job page per posting that carries
 *   schema.org JSON-LD. There is no JSON feed and `robots.txt` disallows crawling; boards are seeded
 *   deliberately and read at a low rate (see `POLICY`).
 * - A portal whose tenant fronts a Jibe career site (the portal then only redirects the browser to
 *   the custom domain): the Jibe site serves JSON at `/api/jobs`, description included. Such a source
 *   sets `params.jibeHost` to one of {@link JIBE_HOSTS}; the key stays the iCIMS tenant.
 */
const JIBE_HOSTS = [
  "www.github.careers",
  "jobs.wakemed.org",
  "jobs.statefarm.com",
  "careers.principal.com",
  "careers.heb.com",
  "careers.costco.com",
];

const PAGE = 100;
/** Cards are paged by the portal; a runaway `rel=next` chain stops here. */
const MAX_PAGES = 500;
const KEY = /^[a-z0-9][a-z0-9-]*$/i;

const jibeHostOf = (source: SourceConfig): string | undefined =>
  typeof source.params.jibeHost === "string" ? source.params.jibeHost : undefined;

const portalUrl = (source: SourceConfig) => `https://${source.key}.icims.com`;
const clean = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** `{label, value}` pairs from an `iCIMS_JobHeaderGroup` (label: its text, else its screen-reader text). */
function headerFields(root: HTMLElement): JsonObject[] {
  return root.querySelectorAll(".iCIMS_JobHeaderTag").flatMap((tag) => {
    const dt = tag.querySelector("dt");
    const label = clean(dt?.querySelector(".sr-only")?.text) || clean(dt?.text);
    const value = clean(tag.querySelector("dd")?.text);
    return value ? [{ label, value }] : [];
  });
}

/** One card of the portal's search results, kept whole. */
function card(el: HTMLElement): JsonObject {
  const anchor = el.querySelector("a.iCIMS_Anchor");
  const url = str(anchor?.getAttribute("href"));
  const jobId = url?.match(/\/jobs\/(\d+)\//)?.[1];
  if (!url || !jobId) throw new SchemaError("iCIMS card without a /jobs/<id>/ link");
  const header = ["left", "right"].flatMap((side) =>
    el.querySelectorAll(`.header.${side} > span:not(.sr-only)`).flatMap((span) => {
      const value = clean(span.text);
      if (!value) return [];
      const label = clean(span.parentNode?.querySelector(".field-label")?.text);
      const title = str(span.getAttribute("title"));
      return [{ side, label, value, ...(title ? { title } : {}) }];
    }),
  );
  return {
    rawHtml: el.toString(),
    id: jobId,
    url: url.replace(/\?.*$/, ""),
    title: clean(el.querySelector("h3")?.text),
    anchorTitle: str(anchor?.getAttribute("title")) ?? null,
    header,
    snippet: clean(el.querySelector(".description")?.text) || null,
    fields: headerFields(el),
  };
}

async function* listPortal(source: SourceConfig, ctx: CollectContext) {
  const base = portalUrl(source);
  let seen = 0;
  const ids = new Set<string>();
  for (let pr = 0; pr < MAX_PAGES; pr++) {
    const html = (await ctx.http.getText(`${base}/jobs/search?pr=${pr}&in_iframe=1`)).data;
    const root = parse(html);
    const cards = root.querySelectorAll("li.iCIMS_JobCardItem");
    if (cards.length === 0) {
      if (pr === 0 && root.querySelector(".iCIMS_ListingsPage")) return; // a real, empty board
      const redirect = /window\.top\.location\.href\s*=\s*'([^']+)'/.exec(html)?.[1];
      throw new SchemaError(
        redirect
          ? `iCIMS portal ${source.key} redirects to ${redirect.replace(/\\\//g, "/")}; its jobs live on that Jibe site (params.jibeHost)`
          : `iCIMS portal ${source.key} page ${pr} has no job cards and is not a listings page`,
      );
    }
    for (const el of cards) {
      const listing = card(el);
      const postingId = String(listing.id);
      if (ids.has(postingId))
        throw new SchemaError(`iCIMS portal ${source.key} repeated posting ${postingId}`);
      ids.add(postingId);
      yield { id: postingId, listing } satisfies RawPosting;
      if (++seen >= ctx.maxPostings)
        throw new SchemaError(`iCIMS portal ${source.key} exhausted its posting budget`);
    }
    if (!root.querySelector('link[rel="next"]')) return;
  }
  throw new SchemaError(`iCIMS portal ${source.key} paged past ${MAX_PAGES} pages`);
}

async function* listJibe(source: SourceConfig, ctx: CollectContext, host: string) {
  let total = Number.POSITIVE_INFINITY;
  const ids = new Set<string>();
  for (let page = 1, seen = 0; seen < total; page++) {
    const { data } = await ctx.http.getJson(`https://${host}/api/jobs?page=${page}&limit=${PAGE}`);
    const jobs = rows(obj(data).jobs, "jobs");
    const totalCount = num(obj(data).totalCount);
    if (totalCount === undefined || !Number.isSafeInteger(totalCount) || totalCount < 0)
      throw new SchemaError("Jibe response without totalCount");
    total = page === 1 ? totalCount : Math.max(total, totalCount);
    for (const job of jobs) {
      const jobId = id(obj(job.data).req_id) ?? id(obj(job.data).slug);
      if (!jobId) throw new SchemaError("Jibe job without req_id");
      if (ids.has(jobId)) throw new SchemaError(`Jibe ${source.key} repeated posting ${jobId}`);
      ids.add(jobId);
      yield { id: jobId, listing: job } satisfies RawPosting;
      if (ids.size >= ctx.maxPostings)
        throw new SchemaError(`Jibe ${source.key} exhausted its posting budget`);
    }
    seen += jobs.length;
    if (jobs.length === 0 && seen < total)
      throw new SchemaError(`Jibe ${source.key} ended at ${seen} of ${total} jobs`);
    if (page >= MAX_PAGES && seen < total)
      throw new SchemaError(`Jibe ${source.key} paged past ${MAX_PAGES} pages`);
  }
}

/** JSON-LD, header fields and ad sections of one job page. */
function parseJobPage(html: string): JsonObject {
  const root = parse(html);
  const ld = jobPostingLd(root);
  const sections = root.querySelectorAll("h2.iCIMS_InfoField_Job").map((h) => ({
    title: clean(h.text),
    html: h.nextElementSibling?.querySelector(".iCIMS_Expandable_Text")?.innerHTML.trim() ?? "",
  }));
  if (!ld && sections.length === 0)
    throw new SchemaError("iCIMS job page without JSON-LD or ad sections");
  return { rawHtml: html, jsonLd: ld ?? null, fields: headerFields(root), sections };
}

export const icims: Platform = {
  id: "icims",
  version: 5,
  hosts: ["*.icims.com", ...JIBE_HOSTS],

  validate(source) {
    if (!KEY.test(source.key)) throw new Error(`Invalid icims key: ${source.key}`);
    const host = jibeHostOf(source);
    if (source.params.jibeHost !== undefined && (!host || !JIBE_HOSTS.includes(host)))
      throw new Error(`icims jibeHost must be one of ${JIBE_HOSTS.join(", ")}`);
  },

  async *list(source, ctx) {
    const host = jibeHostOf(source);
    if (host) yield* listJibe(source, ctx, host);
    else yield* listPortal(source, ctx);
    // An unknown tenant answers 404 (an error), never an empty page; still, one empty answer is
    // not proof enough to close every job.
    return { complete: true, emptyIsAuthoritative: false };
  },

  /** Portal cards carry no description; the job page does (Jibe rows already include it). */
  async detail(source, posting, ctx) {
    if (jibeHostOf(source)) return null;
    const url = str(obj(posting.listing).url);
    if (!url) throw new SchemaError("iCIMS card without url");
    return parseJobPage((await ctx.http.getText(`${url}?in_iframe=1`)).data);
  },

  /** Relative dates ("1 day ago") change daily; the absolute date in `title` stays. */
  fingerprint(listing) {
    const row = obj(listing);
    if (!Array.isArray(row.header)) return listing;
    const originalHtml = str(row.rawHtml);
    let stableHtml = originalHtml;
    if (originalHtml) {
      const root = parse(originalHtml);
      for (const span of root.querySelectorAll(".header.left > span, .header.right > span")) {
        const label = clean(span.parentNode?.querySelector(".field-label")?.text);
        if (/^posted date$/i.test(label) && span.getAttribute("title")) span.set_content("");
      }
      stableHtml = root.toString();
    }
    return {
      ...row,
      ...(stableHtml ? { rawHtml: stableHtml } : {}),
      header: row.header.map((h) => {
        const entry = obj(h);
        return /^posted date$/i.test(str(entry.label) ?? "") && entry.title
          ? { ...entry, value: null }
          : entry;
      }),
    };
  },

  map({ id: postingId, listing, detail }, source) {
    const jibeHost = jibeHostOf(source);
    if (jibeHost) return mapJibe(postingId, listing, jibeHost);
    const card = lookup(listing);
    const page = lookup(detail);
    const ld = lookup(page("jsonLd"));
    const header = arr(card("header")).map(obj);
    const fieldList = [...arr(card("fields")), ...arr(page("fields"))]
      .map(obj)
      .filter(
        (f, i, all) => all.findIndex((g) => g.label === f.label && g.value === f.value) === i,
      );
    const field = (...labels: string[]) =>
      str(fieldList.find((f) => labels.includes(str(f.label)?.toLowerCase() ?? ""))?.value);
    const places = arr(ld("jobLocation")).map((p) => obj(obj(p).address));
    const real = (v: unknown) => (str(v) && str(v) !== "UNAVAILABLE" ? str(v) : undefined);
    const cardPlaces = [...header, ...fieldList].filter((h) =>
      /^(job )?locations?$/i.test(str(h.label) ?? ""),
    );
    const locationText = cardPlaces.map((h) => str(h.value)).join(" | ");
    const parts = locationText.split(/\s*[;|]\s*/).filter(Boolean);
    const only = places.length === 1 && parts.length === 1 ? places[0] : undefined;
    const structure = (a: JsonObject | undefined) => ({
      city: real(a?.addressLocality),
      region: real(a?.addressRegion),
      // sourceLocation normalizes structured country names/codes through ISO tables and leaves
      // unknown values (including unresolved source templates) without a country code.
      country: real(a?.addressCountry),
    });
    const addressPlaces = places
      .map((a) => ({
        text: [real(a.addressLocality), real(a.addressRegion), real(a.addressCountry)]
          .filter(Boolean)
          .join(", "),
        hints: structure(a),
      }))
      .filter((p) => p.text);
    // Several JSON-LD addresses each describe one place, so each keeps its own structure. A single
    // address, or none, is read against the card's own text: the card is the place as the portal states it.
    const placeList =
      addressPlaces.length > 1
        ? locations(addressPlaces)
        : locationText
          ? locations([{ text: locationText, hints: structure(only) }])
          : locations(addressPlaces);
    const sections = arr(page("sections")).map(obj);
    const html = str(ld("description"))
      ? [str(ld("description"))]
      : sections.map((s) => `<h3>${htmlText(str(s.title) ?? "")}</h3>${str(s.html) ?? ""}`);
    const posted = header.find((h) => /posted/i.test(str(h.label) ?? ""));
    return {
      postingId,
      title: str(ld("title")) ?? str(card("title")) ?? "",
      url: str(card("url")),
      description: describe(...html),
      locations: placeList,
      department: field("category") ?? str(ld("occupationalCategory")),
      employmentType: field("position type", "employment type", "job type"),
      requisitionId: field("job id", "id", "req id", "requisition id") ?? postingId,
      postedAt: str(ld("datePosted")),
      expiresAt: str(ld("validThrough")),
      compensation: [],
      experience: [],
      extras: {
        ...(str(ld("occupationalCategory"))
          ? { occupationalCategory: str(ld("occupationalCategory")) }
          : {}),
        ...(str(ld("employmentType")) ? { jsonLdEmploymentType: str(ld("employmentType")) } : {}),
        ...(posted?.title ? { postedDisplay: str(posted.title) } : {}),
        ...(fieldList.length ? { fields: fieldList } : {}),
        ...(header.length
          ? { header: header.map((h) => ({ label: h.label ?? null, value: h.value ?? null })) }
          : {}),
      },
    };
  },
};

function mapJibe(postingId: string, listing: Json, host: string) {
  const j = lookup(obj(listing).data);
  const country = str(j("country_code"));
  const extras: JsonObject = {};
  for (const key of ["tags2", "tags3", "tags4", "tags5", "tags6", "tags7", "categories"]) {
    if (arr(j(key)).length) extras[key] = j(key) as Json;
  }
  return {
    postingId,
    title: str(j("title")) ?? "",
    url: str(j("slug")) ? `https://${host}/jobs/${str(j("slug"))}` : undefined,
    applyUrl: str(j("apply_url")),
    description: describe(j("description"), j("responsibilities"), j("qualifications")),
    locations: locations([
      {
        text: j("full_location") ?? j("location_name"),
        hints: {
          city: str(j("city")),
          region: str(j("state")),
          country: str(j("country")),
          countryCode: country?.toUpperCase(),
        },
      },
    ]),
    department: str(j("department")) ?? str(obj(arr(j("categories"))[0]).name),
    employmentType: str(j("employment_type")),
    requisitionId: str(j("req_id")),
    postedAt: str(j("posted_date")),
    updatedAt: str(j("update_date")),
    expiresAt: str(j("posting_expiry_date")),
    compensation: [],
    experience: [],
    extras: {
      ...extras,
      ...(str(j("hiring_organization"))
        ? { hiringOrganization: str(j("hiring_organization")) }
        : {}),
      ...(str(j("location_name")) ? { locationName: str(j("location_name")) } : {}),
    },
  };
}
