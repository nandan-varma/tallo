import type {
  CollectContext,
  Json,
  JsonObject,
  Platform,
  RawPosting,
  SourceConfig,
} from "@tallo/contracts";
import { arr, isObject, num, obj, str } from "@tallo/contracts";
import { describe, locations, lookup, rows, SchemaError } from "../kit.ts";

/**
 * Apple's public jobs API. `POST /api/v1/search` lists twenty postings a page (no auth); the
 * `GET /api/v1/jobDetails/<id>` detail carries the full description, responsibilities,
 * qualifications and the source's Pay & Benefits footers. The search payload has no description,
 * so detail is one request per changed posting. The older browser-session route is not needed.
 */
const HOST = "https://jobs.apple.com";
const SEARCH = `${HOST}/api/v1/search`;
const DETAIL = `${HOST}/api/v1/jobDetails/`;
const PAGE_SIZE = 20;
const MAX_PAGES = 1000;

const section = (heading: string, value: unknown): string | undefined => {
  const text = str(value);
  return text ? `<h3>${heading}</h3>${text}` : undefined;
};

const searchBody = (page: number) => ({
  query: "",
  filters: {},
  page,
  locale: "en-us",
  sort: "newest",
  format: { longDate: "MMMM D, YYYY", mediumDate: "MMM D, YYYY" },
});

/** Canonical public detail path: Apple uses the job number (REQ) or position id (PIPE) plus the title slug. */
function detailUrl(number: string, slug: string | undefined): string {
  return `${HOST}/en-us/details/${encodeURIComponent(number)}${slug ? `/${slug}` : ""}`;
}

/** The `en_US` Pay & Benefits footer(s), which Apple states separately from the role description. */
function footerSections(detail: Json): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const footer of arr(obj(detail).postingFooters)) {
    for (const entry of arr(obj(obj(footer).localizations).en_US)) {
      const e = obj(entry);
      const name = str(e.name);
      const content = str(e.content);
      const key = `${name ?? ""}\n${content ?? ""}`;
      if (!content || seen.has(key)) continue;
      seen.add(key);
      out.push(`${name ? `<h3>${name}</h3>` : ""}${content}`);
    }
  }
  return out;
}

export const apple: Platform = {
  id: "apple",
  version: 2,
  hosts: ["jobs.apple.com"],

  validate(source) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(source.key))
      throw new Error(`Invalid apple key: ${source.key}`);
  },

  async *list(_source: SourceConfig, ctx: CollectContext) {
    let total = Number.POSITIVE_INFINITY;
    let pages = Number.POSITIVE_INFINITY;
    let complete = true;
    const seen = new Set<string>();
    for (let page = 1; page <= pages; page++) {
      if (page > MAX_PAGES) throw new SchemaError(`Apple paged past ${MAX_PAGES} pages`);
      const body = (await ctx.http.postJson(SEARCH, searchBody(page))).data;
      const res = obj(body).res;
      if (!Array.isArray(obj(res).searchResults))
        throw new SchemaError("Apple search response has no searchResults array");
      const jobs = rows(obj(res).searchResults, "searchResults");
      const reportedTotal = num(obj(res).totalRecords);
      if (reportedTotal === undefined || !Number.isSafeInteger(reportedTotal) || reportedTotal < 0)
        throw new SchemaError("Apple search response has no valid totalRecords");
      if (page === 1) {
        total = reportedTotal;
        pages = total === 0 ? 1 : Math.ceil(total / PAGE_SIZE);
        if (jobs.length === 0 && total > 0)
          throw new SchemaError("Apple reported postings but the first page is empty");
      } else if (reportedTotal !== total) {
        // New or expired postings shift the offset window; the listing is not provably whole.
        complete = false;
      }
      const expected = page < pages ? PAGE_SIZE : total - (pages - 1) * PAGE_SIZE;
      if (jobs.length !== expected) complete = false;
      for (const job of jobs) {
        const id = str(job.id);
        if (!id) throw new SchemaError("Apple search row without an id");
        if (!str(job.postingTitle)) throw new SchemaError(`Apple posting ${id} without a title`);
        if (seen.has(id)) {
          complete = false;
          continue;
        }
        seen.add(id);
        yield { id, listing: job } satisfies RawPosting;
      }
    }
    return {
      complete: complete && seen.size === total,
      // This is the fixed public Apple board; an empty answer is a genuinely empty board.
      emptyIsAuthoritative: true,
    };
  },

  async detail(_source, posting, ctx) {
    const body = (await ctx.http.getJson(`${DETAIL}${encodeURIComponent(posting.id)}`)).data;
    const detail = obj(body).res;
    if (!isObject(detail) || !str(detail.postingTitle) || !str(detail.id))
      throw new SchemaError(`Apple detail ${posting.id} has no posting title or id`);
    return detail;
  },

  map({ id, listing, detail }) {
    const row = lookup(listing);
    const j = lookup(detail);
    const teamNames = arr(j("teamNames"))
      .map((t) => str(t))
      .filter((t): t is string => Boolean(t));
    const number =
      str(j("jobNumber")) ?? str(j("positionId")) ?? str(row("positionId")) ?? str(row("id")) ?? id;
    const slug = str(j("transformedPostingTitle")) ?? str(row("transformedPostingTitle"));
    const postedAt =
      str(j("postingDateMeta")) ?? str(j("postDateInGMT")) ?? str(row("postDateInGMT"));
    const homeOffice = j("homeOffice") === true;
    const employmentType = str(j("employmentType")) ?? str(row("employmentType"));
    // Search rows state weekly hours for some roles whose detail does not repeat them.
    const weeklyHours = num(j("standardWeeklyHours")) ?? num(row("standardWeeklyHours"));
    return {
      postingId: id,
      title: str(j("postingTitle")) ?? str(row("postingTitle")) ?? "",
      url: detailUrl(number, slug),
      description: describe(
        j("jobSummary") ?? row("jobSummary"),
        section("Description", j("description")),
        section("Responsibilities", j("responsibilities")),
        section("Minimum qualifications", j("minimumQualifications")),
        section("Preferred qualifications", j("preferredQualifications")),
        ...footerSections(obj(detail)),
      ),
      locations: locations(
        arr(j("locations") ?? row("locations")).map((entry) => {
          const place = obj(entry);
          const city = str(place.city);
          const region = str(place.stateProvince);
          const country = str(place.countryName);
          const name = str(place.name);
          return {
            text: [city, region, country].filter(Boolean).join(", ") || name || country,
            hints: { city, region, country },
          };
        }),
      ),
      ...(homeOffice ? { workMode: "remote" as const } : {}),
      ...(teamNames[0] ? { department: teamNames[0] } : {}),
      ...(employmentType ? { employmentType } : {}),
      requisitionId: str(j("jobNumber")) ?? str(j("reqId")) ?? id,
      ...(postedAt ? { postedAt } : {}),
      compensation: [],
      experience: [],
      extras: {
        ...(teamNames.length ? { teams: teamNames } : {}),
        ...(str(j("jobType")) ? { jobType: str(j("jobType")) } : {}),
        ...(str(j("highJobTitle")) ? { highJobTitle: str(j("highJobTitle")) } : {}),
        ...(weeklyHours !== undefined ? { standardWeeklyHours: weeklyHours } : {}),
        ...(j("homeOffice") !== undefined ? { homeOffice: j("homeOffice") } : {}),
        ...(str(j("type")) ? { type: str(j("type")) } : {}),
        ...(str(j("postingDate")) ? { postingDate: str(j("postingDate")) } : {}),
      } satisfies JsonObject,
    };
  },
};
