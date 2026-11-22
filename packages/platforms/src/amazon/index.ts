import type {
  Json,
  JsonObject,
  Platform,
  RawPosting,
  SourceConfig,
  WorkMode,
} from "@tallo/contracts";
import { isObject, num, obj, str } from "@tallo/contracts";
import { definedOnly, describe, locations, lookup, rows, SchemaError, workModeOf } from "../kit.ts";

/**
 * Amazon's public jobs search JSON. One request returns up to 100 complete posting rows, including the
 * full description, qualifications and structured locations; the job page adds no structured fact, so
 * there is no per-posting detail call.
 *
 * The public search caps any one query at 10,000 results (`hits` stops at 10000 and offset 10000 is an
 * error). A source can narrow the board with Amazon's own structured `category[]` facet. A query whose
 * `hits` reaches the cap may be truncated, so it is never reported complete.
 */
const PAGE = 100;
const CAP = 10_000;
const ORIGIN = "https://www.amazon.jobs";
const KEY = /^[a-z0-9][a-z0-9-]{1,63}$/;

const categoryOf = (source: SourceConfig): string | undefined => str(source.params.category);

const searchUrl = (source: SourceConfig, offset: number): string => {
  const params = new URLSearchParams({
    base_query: "",
    sort: "recent",
    result_limit: String(PAGE),
    offset: String(offset),
  });
  const category = categoryOf(source);
  if (category) params.append("category[]", category);
  return `${ORIGIN}/en/search.json?${params}`;
};

/** One search answer: its reported total and its rows, validated before anything is yielded. */
function pageOf(data: unknown): { hits: number; jobs: JsonObject[] } {
  if (!isObject(data)) throw new SchemaError("Amazon Jobs search answer is not an object");
  if (data.error !== null && data.error !== undefined)
    throw new SchemaError(`Amazon Jobs search error: ${str(data.error) ?? "unknown"}`);
  const hits = num(data.hits);
  if (hits === undefined || !Number.isSafeInteger(hits) || hits < 0)
    throw new SchemaError("Amazon Jobs search answer without a valid hits count");
  if (!Array.isArray(data.jobs))
    throw new SchemaError("Amazon Jobs search answer without a jobs array");
  // The API rejects result_limit above 100; more rows than asked for means the shape changed.
  if (data.jobs.length > PAGE)
    throw new SchemaError(`Amazon Jobs returned ${data.jobs.length} rows for a ${PAGE}-row page`);
  if (data.jobs.length > hits)
    throw new SchemaError("Amazon Jobs returned more jobs than its own hits count");
  return { hits, jobs: rows(data.jobs, "jobs") };
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** `November 20, 2026` (the listing's stated format) to `YYYY-MM-DD`; anything else is not guessed at. */
function postedDate(value: unknown): string | undefined {
  const match = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(str(value) ?? "");
  if (!match) return undefined;
  const month = MONTHS[match[1]!.toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Amazon's `locations` is an array of JSON-encoded objects (not plain objects). A malformed entry is a
 * shape change, never a posting with no place.
 */
function locationEntries(value: unknown): JsonObject[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SchemaError("Amazon Jobs locations is not an array");
  return value.map((entry) => {
    if (isObject(entry)) return entry;
    const text = str(entry);
    if (!text) throw new SchemaError("Amazon Jobs location entry is empty");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SchemaError("Amazon Jobs location entry is not JSON");
    }
    if (!isObject(parsed)) throw new SchemaError("Amazon Jobs location entry is not an object");
    if (str(parsed.location) === undefined && str(parsed.normalizedLocation) === undefined)
      throw new SchemaError("Amazon Jobs location entry without a place");
    return parsed;
  });
}

const modeOf = (type: unknown): WorkMode | undefined =>
  str(type)?.toUpperCase() === "VIRTUAL" ? "remote" : workModeOf(type);

/** Work mode only when every structured location states the same one. Mixed places stay unknown. */
function workModeOfPlaces(entries: JsonObject[]): WorkMode | undefined {
  const modes = entries.map((entry) => modeOf(entry.type));
  const first = modes[0];
  return first && modes.every((mode) => mode === first) ? first : undefined;
}

/** Only an official Amazon application URL; anything else is left unstated rather than linked. */
function applyUrlOf(value: unknown): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") return undefined;
    if (url.hostname !== "account.amazon.jobs" && url.hostname !== "www.amazon.jobs")
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** The id the listing and its official job path agree on; a missing or non-numeric id is a shape change. */
function postingIdOf(job: JsonObject): string {
  const postingId = str(job.id_icims);
  if (!postingId || !/^\d{1,20}$/.test(postingId))
    throw new SchemaError("Amazon Jobs listing row without a numeric id_icims");
  return postingId;
}

const bool = (value: Json | undefined): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

export const amazon: Platform = {
  id: "amazon",
  version: 1,
  hosts: ["www.amazon.jobs"],
  validate(source) {
    if (!KEY.test(source.key)) throw new Error(`Invalid amazon key: ${source.key}`);
    const raw = source.params.category;
    const category = categoryOf(source);
    if (raw !== undefined && category === undefined)
      throw new Error(`Amazon Jobs params.category must be a non-empty string: ${source.key}`);
    if (
      category !== undefined &&
      (category.length > 120 ||
        [...category].some((char) => {
          const code = char.codePointAt(0) ?? 0;
          return code < 0x20 || code === 0x7f;
        }))
    )
      throw new Error(`Amazon Jobs params.category is not a category label: ${source.key}`);
  },

  async *list(source, ctx) {
    let total: number | undefined;
    let complete = true;
    let capped = false;
    const seen = new Set<string>();
    let firstPageIds: string[] | undefined;
    for (let offset = 0; ; offset += PAGE) {
      if (offset >= CAP) {
        capped = true;
        ctx.record({
          code: "pagination",
          message: `Amazon Jobs search caps at ${CAP} results; hits reports ${total ?? CAP}`,
        });
        break;
      }
      if (total !== undefined && offset >= total) break;
      const page = pageOf((await ctx.http.getJson(searchUrl(source, offset))).data);
      if (total === undefined) {
        total = page.hits;
        if (total >= CAP) {
          // `hits` stops at 10,000 even when the real board is larger; never mistake the cap for the end.
          capped = true;
          ctx.record({
            code: "pagination",
            message: `Amazon Jobs reports ${total} hits, at or above the ${CAP}-result search cap`,
          });
        }
      } else if (page.hits !== total) {
        complete = false;
        ctx.record({
          code: "pagination",
          message: `Amazon Jobs hits changed from ${total} to ${page.hits} at offset ${offset}`,
        });
        total = page.hits;
      }
      const pageStart = offset;
      if (page.jobs.length === 0) {
        if (pageStart < total) {
          complete = false;
          ctx.record({
            code: "pagination",
            message: `Amazon Jobs ended at offset ${pageStart} of ${total}`,
          });
        }
        break;
      }
      if (page.jobs.length < PAGE && pageStart + PAGE < total) {
        complete = false;
        ctx.record({
          code: "pagination",
          message: `Amazon Jobs short page (${page.jobs.length}) at offset ${pageStart} of ${total}`,
        });
      }
      if (firstPageIds === undefined) firstPageIds = page.jobs.map(postingIdOf);
      let fresh = 0;
      for (const job of page.jobs) {
        const postingId = postingIdOf(job);
        if (seen.has(postingId)) {
          complete = false;
          ctx.record({
            code: "pagination",
            message: `Amazon Jobs repeated posting ${postingId} at offset ${pageStart}`,
          });
          continue;
        }
        seen.add(postingId);
        fresh++;
        yield { id: postingId, listing: job } satisfies RawPosting;
        if (seen.size >= ctx.maxPostings) {
          ctx.record({
            code: "budget",
            message: `Stopped at ${ctx.maxPostings} postings`,
          });
          return { complete: false, emptyIsAuthoritative: false };
        }
      }
      if (fresh === 0) {
        // A full page of known ids means paging is repeating itself; stop instead of looping forever.
        complete = false;
        ctx.record({
          code: "pagination",
          message: `Amazon Jobs repeated page at offset ${pageStart}`,
        });
        break;
      }
    }
    if (total === undefined) throw new SchemaError("Amazon Jobs search returned no page");
    if (capped) complete = false;
    // Paging is by offset over a "recent" order. A second look at the first page catches a posting
    // inserted during the run, which would otherwise shift one unseen row past every offset we read.
    if (complete && total > 0 && firstPageIds !== undefined) {
      const check = pageOf((await ctx.http.getJson(searchUrl(source, 0))).data);
      const ids = check.jobs.map(postingIdOf);
      if (
        check.hits !== total ||
        ids.length !== firstPageIds.length ||
        ids.some((postingId, i) => postingId !== firstPageIds[i])
      ) {
        complete = false;
        ctx.record({
          code: "pagination",
          message: `Amazon Jobs first page changed during the listing (hits ${total} -> ${check.hits})`,
        });
      }
    }
    if (seen.size < total) {
      complete = false;
      ctx.record({
        code: "pagination",
        message: `Amazon Jobs listing saw ${seen.size} of ${total} reported jobs`,
      });
    }
    // A typo in a facet value answers 200 with zero jobs, so an empty answer proves nothing about the board.
    return { complete, emptyIsAuthoritative: false };
  },

  fingerprint: (listing) => {
    // Relative freshness labels and distance-to-search-centre change between runs, not the posting.
    const { updated_time, display_distance, ...stable } = obj(listing);
    return stable;
  },

  map({ id: postingId, listing }) {
    const j = lookup(listing);
    const places = locationEntries(j("locations"));
    const path = str(j("job_path"));
    const url =
      path?.startsWith("/en/jobs/") === true
        ? `${ORIGIN}${path}`
        : `${ORIGIN}/en/jobs/${postingId}`;
    const applyUrl = applyUrlOf(j("url_next_step"));
    return {
      postingId,
      title: str(j("title")) ?? "",
      url,
      ...(applyUrl ? { applyUrl } : {}),
      description: describe(
        j("description"),
        j("basic_qualifications"),
        j("preferred_qualifications"),
      ),
      locations: locations(
        places.length > 0
          ? places.map((place) => ({
              text: place.location ?? place.normalizedLocation,
              hints: {
                city: str(place.city),
                region: str(place.normalizedStateName),
                countryCode: /^[A-Za-z]{2}$/.test(str(place.countryIso2a) ?? "")
                  ? str(place.countryIso2a)?.toUpperCase()
                  : undefined,
                remote: str(place.type)?.toUpperCase() === "VIRTUAL" ? true : undefined,
              },
            }))
          : [{ text: j("normalized_location") ?? j("location") }],
      ),
      workMode: workModeOfPlaces(places),
      department: str(j("job_category")),
      team: str(j("business_category")),
      employmentType: str(j("job_schedule_type")),
      requisitionId: postingId,
      postedAt: postedDate(j("posted_date")),
      compensation: [],
      experience: [],
      extras: definedOnly({
        jobFamily: str(j("job_family")),
        businessCategory: str(j("business_category")),
        companyName: str(j("company_name")),
        sourceSystem: str(j("source_system")),
        listingId: str(j("id")),
        isIntern: bool(j("is_intern")),
        isManager: bool(j("is_manager")),
        universityJob: bool(j("university_job")),
        jobFunctionId: str(j("job_function_id")),
      }),
    };
  },
};
