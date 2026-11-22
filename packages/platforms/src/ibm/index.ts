import type { Json, JsonObject, Platform, RawPosting } from "@tallo/contracts";
import { arr, isObject, num, obj, str } from "@tallo/contracts";
import { describe, locations, lookup, SchemaError, workModeOf } from "../kit.ts";

/**
 * IBM's careers search (the index behind ibm.com/careers/search). One POST returns up to 100 complete
 * postings with their full description, so there is no per-posting detail call. The job pages on
 * careers.ibm.com sit behind a browser challenge and are never fetched; they are only linked.
 *
 * The search window is capped at 10,000 rows (`from` above it is an error). A larger board is never
 * reported complete.
 */
const API = "https://www-api.ibm.com/search/api/v2";
const PAGE = 100;
const WINDOW = 10_000;

/** `_source` is a whitelist of field names. These are the fields the careers index fills for a posting. */
const FIELDS = [
  "title",
  "url",
  "dcdate",
  "description",
  "body",
  "language",
  "country",
  "field_keyword_05",
  "field_keyword_08",
  "field_keyword_17",
  "field_keyword_18",
  "field_keyword_19",
  "field_keyword_20",
  "field_keyword_21",
  "field_keyword_23",
  "field_text_01",
];

const requestBody = (from: number): Json => ({
  appId: "careers",
  scopes: ["careers2"],
  query: { bool: { must: [] } },
  lang: "zz",
  size: PAGE,
  from,
  // A total order, so offset paging neither repeats nor skips rows while the board is unchanged.
  sort: [{ dcdate: "desc" }, { _id: "asc" }],
  _source: FIELDS,
});

function pageOf(data: unknown): { total: number; hits: JsonObject[] } {
  if (!isObject(data)) throw new SchemaError("IBM careers search answer is not an object");
  const hits = obj(data.hits);
  const total = obj(hits.total);
  const value = num(total.value);
  if (value === undefined || !Number.isSafeInteger(value) || value < 0)
    throw new SchemaError("IBM careers search answer without a valid total");
  // A lower bound ("gte") is not a count; never page against it.
  if (str(total.relation) !== "eq") throw new SchemaError("IBM careers search total is inexact");
  if (!Array.isArray(hits.hits)) throw new SchemaError("IBM careers search answer without hits");
  if (hits.hits.length > PAGE)
    throw new SchemaError(
      `IBM careers search returned ${hits.hits.length} rows for a ${PAGE} page`,
    );
  if (!hits.hits.every(isObject)) throw new SchemaError("IBM careers search hit is not an object");
  return { total: value, hits: hits.hits as JsonObject[] };
}

/** The numeric requisition number IBM states for a posting (also the `jobId` of its page). */
function postingIdOf(hit: JsonObject): string {
  const id = num(obj(hit._source).field_text_01);
  if (id === undefined || !Number.isSafeInteger(id) || id <= 0)
    throw new SchemaError("IBM careers hit without a numeric field_text_01");
  return String(id);
}

const strings = (value: unknown): string[] =>
  arr(value)
    .map((v) => str(v))
    .filter((v): v is string => v !== undefined);

/** Only an IBM careers URL is linked; anything else is left unstated. */
function pageUrlOf(value: unknown): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname === "careers.ibm.com" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const dateOf = (value: unknown): string | undefined => {
  const text = str(value);
  return text !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
};

export const ibm: Platform = {
  id: "ibm",
  version: 1,
  hosts: ["www-api.ibm.com"],
  validate(source) {
    if (source.key !== "ibm") throw new Error(`IBM source key must be ibm: ${source.key}`);
  },

  async *list(_source, ctx) {
    const seen = new Set<string>();
    let total: number | undefined;
    let complete = true;
    for (let from = 0; ; from += PAGE) {
      if (from >= WINDOW) {
        complete = false;
        ctx.record({
          code: "pagination",
          message: `IBM careers search window ends at ${WINDOW}; the board reports ${total ?? WINDOW}`,
        });
        break;
      }
      if (total !== undefined && from >= total) break;
      const page = pageOf((await ctx.http.postJson(API, requestBody(from))).data);
      if (total === undefined) total = page.total;
      else if (page.total !== total) {
        complete = false;
        ctx.record({
          code: "pagination",
          message: `IBM careers total changed from ${total} to ${page.total} at offset ${from}`,
        });
        total = page.total;
      }
      if (page.hits.length === 0) {
        if (from < total) {
          complete = false;
          ctx.record({
            code: "pagination",
            message: `IBM careers search ended at offset ${from} of ${total}`,
          });
        }
        break;
      }
      if (page.hits.length < PAGE && from + PAGE < total) {
        complete = false;
        ctx.record({
          code: "pagination",
          message: `IBM careers short page (${page.hits.length}) at offset ${from} of ${total}`,
        });
      }
      for (const hit of page.hits) {
        const postingId = postingIdOf(hit);
        if (seen.has(postingId)) {
          complete = false;
          ctx.record({
            code: "pagination",
            message: `IBM careers repeated posting ${postingId} at offset ${from}`,
          });
          continue;
        }
        seen.add(postingId);
        yield { id: postingId, listing: hit } satisfies RawPosting;
        if (seen.size >= ctx.maxPostings) {
          ctx.record({ code: "budget", message: `Stopped at ${ctx.maxPostings} postings` });
          return { complete: false, emptyIsAuthoritative: false };
        }
      }
    }
    if (total === undefined) throw new SchemaError("IBM careers search returned no page");
    if (seen.size < total) {
      complete = false;
      ctx.record({
        code: "pagination",
        message: `IBM careers listing saw ${seen.size} of ${total} reported postings`,
      });
    }
    // The shared index answers 200 for any query, so an empty answer is not proof the board is empty.
    return { complete, emptyIsAuthoritative: false };
  },

  /** The index name embeds a build timestamp and `sort`/`_score` are paging artefacts, not the posting. */
  fingerprint: (listing) => obj(listing)._source ?? null,

  map({ id: postingId, listing }) {
    const j = lookup(obj(listing)._source);
    const cities = strings(j("field_keyword_21"));
    const countries = strings(j("country"));
    const countryCode =
      countries.length === 1 && /^[A-Za-z]{2}$/.test(countries[0]!)
        ? countries[0]!.toUpperCase()
        : undefined;
    const skills = strings(j("field_keyword_23"));
    const url = pageUrlOf(j("url"));
    const extras: JsonObject = {};
    const put = (key: string, value: Json | undefined) => {
      if (value !== undefined) extras[key] = value;
    };
    put("careerLevel", str(j("field_keyword_18")));
    put("legalEntity", str(j("field_keyword_20")));
    put("language", str(j("language")));
    put("indexedDate", dateOf(j("dcdate")));
    if (skills.length > 0) put("skills", skills);
    return {
      postingId,
      title: str(j("title")) ?? "",
      url,
      applyUrl: url,
      description: describe(j("body") ?? j("description")),
      locations: locations([
        {
          text: j("field_keyword_19") ?? cities[0],
          hints: {
            city: cities.length === 1 ? cities[0] : undefined,
            country: str(j("field_keyword_05")),
            countryCode,
          },
        },
      ]),
      workMode: workModeOf(j("field_keyword_17")),
      department: str(j("field_keyword_08")),
      requisitionId: postingId,
      compensation: [],
      experience: [],
      extras,
    };
  },
};
