import type {
  CollectContext,
  JobLocation,
  Json,
  JsonObject,
  Money,
  PayInterval,
  Platform,
  RawPosting,
  SourceConfig,
  WorkMode,
} from "@tallo/contracts";
import { arr, id, isObject, obj, str } from "@tallo/contracts";
import { parse } from "node-html-parser";
import { describe, locations, requireKey, rows, SchemaError } from "../kit.ts";

/**
 * Meta Careers is one anonymous Relay surface. The job search page embeds a short-lived `lsd` token;
 * the public `/api/graphql/` endpoint accepts a persisted document id with that token, no account.
 * The listing query returns every matching job in one response (the site paginates in the browser);
 * the job page carries schema.org JSON-LD plus the same detail query preloaded in a JSON script.
 *
 * A software-only board is an explicit, structured team scope (`params.teams`), never a text guess.
 */
const ORIGIN = "https://www.metacareers.com";
const SEARCH_DOC = "40084319704492118";
const SEARCH_NAME = "CareersJobSearchResultsDataQuery";
/** Every field the search response may contain; the response is still read explicitly. */
const JOB_ID = /^\d{1,20}$/;
/**
 * The board is not paged, so there is no last page to see. A result set exactly at one of these
 * round numbers is the shape of a server cap and is reported as incomplete rather than trusted.
 */
const SUSPICIOUS_CAPS = new Set([1_000, 2_000, 5_000, 10_000]);
const INTERVALS: Record<string, PayInterval> = {
  year: "year",
  month: "month",
  week: "week",
  day: "day",
  hour: "hour",
};

interface Token {
  lsd: string;
  params: Record<string, string>;
}

/** The official structured team scope, as the site's own `teams` URL filter spells it. */
function teamsOf(source: SourceConfig): string[] {
  const raw = source.params.teams;
  if (raw === undefined) return [];
  if (typeof raw !== "string")
    throw new Error(`Meta params.teams must be a comma-separated string: ${source.key}`);
  const teams = raw
    .split(",")
    .map((team) => team.trim())
    .filter(Boolean);
  if (teams.length === 0) throw new Error(`Meta params.teams is empty: ${source.key}`);
  const seen = new Set<string>();
  for (const team of teams) {
    if (team.length > 100) throw new Error(`Meta team name is too long: ${team}`);
    const key = team.toLowerCase();
    if (seen.has(key)) throw new Error(`Meta params.teams repeats ${team}: ${source.key}`);
    seen.add(key);
  }
  return teams;
}

function siteData(html: string): Record<string, Json> {
  const match = /"SiteData",\[\],(\{[^{}]*\}),\d+\]/.exec(html);
  if (!match?.[1]) return {};
  try {
    const value = JSON.parse(match[1]);
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

/** The page's anonymous token and the Request params its GraphQL client sends. */
function tokenFrom(html: string): Token {
  const lsd = /"LSD",\[\],\{"token":"([^"]+)"\}/.exec(html)?.[1];
  if (!lsd) throw new SchemaError("Meta job search page has no LSD token");
  const site = siteData(html);
  const text = (key: string): string | undefined => {
    const value = site[key];
    return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
  };
  const params: Record<string, string> = {
    __user: "0",
    __a: "1",
    dpr: text("pr") ?? "1",
    __ccg: "UNKNOWN",
  };
  const optional: Record<string, string> = {
    __hs: text("haste_session") ?? "",
    __rev: text("client_revision") ?? "",
    __hsi: text("hsi") ?? "",
    __comet_req: text("comet_env") ?? "",
    __spin_r: text("__spin_r") ?? "",
    __spin_b: text("__spin_b") ?? "",
    __spin_t: text("__spin_t") ?? "",
  };
  for (const [key, value] of Object.entries(optional)) if (value) params[key] = value;
  return { lsd, params };
}

async function bootstrap(ctx: CollectContext): Promise<Token> {
  const response = await ctx.http.getText(`${ORIGIN}/jobsearch/`, {
    headers: { accept: "text/html,application/xhtml+xml" },
  });
  return tokenFrom(response.data);
}

/**
 * The endpoint reads its form fields from the query string and ignores the request body. Sending the
 * empty JSON body the shared Http client always sends, with a form content type, keeps the platform
 * inside the existing I/O contract while matching what the endpoint accepts.
 */
async function search(ctx: CollectContext, token: Token, teams: string[]): Promise<Json> {
  const variables = {
    isLoggedIn: false,
    search_input: {
      q: null,
      divisions: [],
      offices: [],
      roles: [],
      leadership_levels: [],
      saved_jobs: [],
      saved_searches: [],
      sub_teams: [],
      teams,
      is_leadership: false,
      is_remote_only: false,
      sort_by_new: false,
      results_per_page: null,
    },
    viewasUserID: null,
  };
  const query = new URLSearchParams({
    ...token.params,
    lsd: token.lsd,
    doc_id: SEARCH_DOC,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: SEARCH_NAME,
    variables: JSON.stringify(variables),
    server_timestamps: "true",
  });
  const response = await ctx.http.postJson(
    `${ORIGIN}/api/graphql/?${query.toString()}`,
    {},
    {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-lsd": token.lsd,
        origin: ORIGIN,
        referer: `${ORIGIN}/jobsearch/`,
      },
    },
  );
  return response.data;
}

/** One GraphQL read, retrying once with a fresh public page token when the token was rejected. */
async function searchWithToken(ctx: CollectContext, teams: string[]): Promise<JsonObject> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await bootstrap(ctx);
    try {
      const body = obj(await search(ctx, token, teams));
      if (Array.isArray(body.errors) && body.errors.length > 0)
        throw new SchemaError("Meta search answered with GraphQL errors");
      return body;
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (attempt === 0 && (status === 400 || status === 403)) continue;
      throw error;
    }
  }
  throw new SchemaError("Meta search kept rejecting a freshly fetched public token");
}

/** The job page's JSON-LD and the preloaded detail query, both the source's own JSON. */
function parseJobPage(html: string, postingId: string): JsonObject {
  const root = parse(html);
  const jobPosting = root
    .querySelectorAll('script[type="application/ld+json"]')
    .map((script) => {
      try {
        return JSON.parse(script.text) as Json;
      } catch {
        return undefined;
      }
    })
    .find((value) => isObject(value) && value["@type"] === "JobPosting");
  if (!isObject(jobPosting))
    throw new SchemaError(`Meta job ${postingId} has no JobPosting JSON-LD (closed or moved)`);

  let details: JsonObject | undefined;
  for (const script of root.querySelectorAll('script[type="application/json"]')) {
    let value: Json;
    try {
      value = JSON.parse(script.text);
    } catch {
      continue;
    }
    details = findDetails(value, 0);
    if (details) break;
  }
  if (!details) throw new SchemaError(`Meta job ${postingId} has no preloaded job details`);
  if (id(details.id) !== postingId)
    throw new SchemaError(`Meta job page answered for ${id(details.id)}, not ${postingId}`);
  return { jobPosting, jobDetails: details };
}

function findDetails(value: Json, depth: number): JsonObject | undefined {
  if (depth > 64) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDetails(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const details = value.xcp_requisition_job_description;
  if (isObject(details)) return details;
  for (const entry of Object.values(value)) {
    const found = findDetails(entry, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** A `{"__html": "..."}` field the source stores as a JSON-encoded string. */
function htmlOf(value: unknown): string {
  const raw = str(value);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as Json;
    return str(obj(parsed).__html) ?? raw;
  } catch {
    return raw;
  }
}

function bulletList(label: string, value: unknown): string {
  const items = arr(value)
    .map((entry) => str(obj(entry).item))
    .filter((item): item is string => item !== undefined);
  if (items.length === 0) return "";
  return `<h3>${label}</h3><ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function amountOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /(\d[\d,]*(?:\.\d+)?)/.exec(value);
  if (!match?.[1]) return undefined;
  const amount = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

/** Base pay, only from the structured `public_compensation` rows. */
function compensationOf(value: unknown): Money[] {
  return arr(value).flatMap((entry) => {
    const row = obj(entry);
    const minText = str(row.compensation_amount_minimum);
    const maxText = str(row.compensation_amount_maximum);
    const min = amountOf(minText);
    const max = amountOf(maxText);
    if (min === undefined && max === undefined) return [];
    const stated = `${minText ?? ""} ${maxText ?? ""}`;
    const suffix = /\/\s*(year|month|week|day|hour)\b/i.exec(stated)?.[1]?.toLowerCase();
    const country = str(row.country_code);
    const currency = country === "US" && stated.includes("$") ? "USD" : undefined;
    const text = [minText, maxText].filter(Boolean).join(" - ");
    const band: Money = {
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(currency === undefined ? {} : { currency }),
      interval: suffix ? (INTERVALS[suffix] ?? "unknown") : "unknown",
      component: "base",
      ...(country === undefined ? {} : { region: country }),
      ...(text ? { text } : {}),
    };
    return [band];
  });
}

/** Keep whole values up to the facts column limit instead of cutting a name in half. */
function joinCapped(values: string[], max = 200): string | undefined {
  let out = "";
  for (const value of values) {
    const next = out ? `${out}, ${value}` : value;
    if (next.length > max) break;
    out = next;
  }
  return out || undefined;
}

const strings = (value: unknown): string[] =>
  arr(value)
    .map((entry) => str(entry))
    .filter((entry): entry is string => entry !== undefined);

export const meta: Platform = {
  id: "meta",
  version: 1,
  hosts: ["www.metacareers.com"],

  validate(source) {
    requireKey(source);
    for (const key of Object.keys(source.params))
      if (key !== "teams" && key !== "egress")
        throw new Error(`Unknown Meta param "${key}": ${source.key}`);
    const teams = teamsOf(source);
    // A scoped query needs its own source identity, or it would overwrite the full board's rows.
    if (teams.length > 0 && source.key === "meta")
      throw new Error(
        'Meta params.teams needs a distinct source key (for example "meta-software")',
      );
  },

  async *list(source, ctx) {
    const teams = teamsOf(source);
    const body = await searchWithToken(ctx, teams);
    const root = obj(body.data).job_search_with_featured_jobs_v2;
    if (!isObject(root)) throw new SchemaError("Meta search response has no job search result");
    const all = rows(root.all_jobs, "all_jobs");
    const featured = rows(root.featured_jobs, "featured_jobs");

    const seen = new Set<string>();
    const allIds = new Set<string>();
    const featuredIds = new Set<string>();
    for (const job of all) {
      const postingId = id(job.id);
      if (!postingId || !JOB_ID.test(postingId))
        throw new SchemaError("Meta all_jobs row has no numeric posting id");
      if (allIds.has(postingId))
        throw new SchemaError(`Meta all_jobs repeats posting ${postingId}`);
      // A scoped query that answered with a job outside its team is not the query we asked for.
      if (teams.length > 0 && !strings(job.teams).some((team) => teams.includes(team)))
        throw new SchemaError(`Meta all_jobs returned ${postingId} outside the team scope`);
      allIds.add(postingId);
      seen.add(postingId);
      yield { id: postingId, listing: job } satisfies RawPosting;
    }
    for (const job of featured) {
      const postingId = id(job.id);
      if (!postingId || !JOB_ID.test(postingId))
        throw new SchemaError("Meta featured_jobs row has no numeric posting id");
      if (featuredIds.has(postingId))
        throw new SchemaError(`Meta featured_jobs repeats posting ${postingId}`);
      featuredIds.add(postingId);
      // The featured list ignores the team filter, so a scoped board keeps only matching jobs.
      if (teams.length > 0 && !strings(job.teams).some((team) => teams.includes(team))) continue;
      // Featured jobs are normally not repeated in all_jobs; an overlap is deduped, not an error.
      if (seen.has(postingId)) continue;
      seen.add(postingId);
      yield { id: postingId, listing: job } satisfies RawPosting;
    }

    let complete = true;
    const reported = SUSPICIOUS_CAPS.has(all.length) || SUSPICIOUS_CAPS.has(seen.size);
    if (reported) {
      complete = false;
      ctx.record({
        code: "pagination",
        message: `Meta listing returned ${seen.size} jobs, the shape of a server result cap`,
      });
    }
    return { complete, emptyIsAuthoritative: teams.length === 0 };
  },

  async detail(_source, posting, ctx) {
    if (!JOB_ID.test(posting.id))
      throw new SchemaError(`Unexpected Meta posting id: ${posting.id}`);
    const response = await ctx.http.getText(
      `${ORIGIN}/profile/job_details/${encodeURIComponent(posting.id)}/`,
      { headers: { accept: "text/html,application/xhtml+xml" } },
    );
    return parseJobPage(response.data, posting.id);
  },

  /** Locations and teams are the only listing fields; their order is not meaningful. */
  fingerprint: (listing) => {
    const row = obj(listing);
    return {
      id: row.id ?? null,
      title: row.title ?? null,
      locations: strings(row.locations).sort(),
      teams: strings(row.teams).sort(),
      subTeams: strings(row.sub_teams).sort(),
    };
  },

  map({ id: postingId, listing, detail }) {
    const row = obj(listing);
    const page = obj(detail);
    const ld = obj(page.jobPosting);
    const details = obj(page.jobDetails);
    const listingTitle = str(row.title);
    const listingLocations = strings(row.locations);

    const departments = strings(details.departments).length
      ? strings(details.departments)
      : strings(row.teams);
    const internal = strings(details.internal_departments).length
      ? strings(details.internal_departments)
      : strings(row.sub_teams);
    const applicantCountries = arr(ld.applicantLocationRequirements)
      .map((entry) => str(obj(entry).name))
      .filter((name): name is string => name !== undefined);
    const jobLocationType = str(ld.jobLocationType);
    const workMode: WorkMode | undefined = jobLocationType === "TELECOMMUTE" ? "remote" : undefined;

    const placeEntries: { text: string; hints: Partial<JobLocation> }[] = [];
    for (const entry of arr(ld.jobLocation)) {
      const place = obj(entry);
      const address = obj(place.address);
      const city = str(address.addressLocality);
      const region = str(address.addressRegion);
      const country = str(address.addressCountry);
      const text =
        str(place.name) ??
        [city, region, country].filter((part): part is string => part !== undefined).join(", ");
      if (!text) continue;
      const hints: Partial<JobLocation> = {};
      if (city) hints.city = city;
      if (region) hints.region = region;
      if (country) hints.country = country;
      placeEntries.push({ text, hints });
    }
    // The listing is the same place data as the page's own "locations" field, without structure.
    const placeList =
      placeEntries.length > 0
        ? locations(placeEntries)
        : locations(listingLocations.map((text) => ({ text })));

    const publicCompensation = arr(details.public_compensation).map(obj);
    const flags = publicCompensation.find(
      (entry) => typeof entry.has_bonus === "boolean" || typeof entry.has_equity === "boolean",
    );
    const extras: JsonObject = {
      teams: strings(row.teams),
      subTeams: strings(row.sub_teams),
      departments,
      internalDepartments: internal,
      applicantCountries,
    };
    if (jobLocationType) extras.jobLocationType = jobLocationType;
    if (typeof flags?.has_bonus === "boolean") extras.hasBonus = flags.has_bonus;
    if (typeof flags?.has_equity === "boolean") extras.hasEquity = flags.has_equity;

    const url = `${ORIGIN}/profile/job_details/${postingId}/`;
    const description = [
      htmlOf(details.description) || str(ld.description) || "",
      bulletList("Responsibilities", details.responsibilities),
      bulletList("Minimum qualifications", details.minimum_qualifications),
      bulletList("Preferred qualifications", details.preferred_qualifications),
    ]
      .filter(Boolean)
      .join("\n");

    return {
      postingId,
      title: str(ld.title) ?? listingTitle ?? "",
      url,
      applyUrl: url,
      description: describe(description),
      locations: placeList,
      ...(workMode === undefined ? {} : { workMode }),
      department: joinCapped(departments),
      team: joinCapped(internal),
      employmentType: str(ld.employmentType),
      requisitionId: str(obj(ld.identifier).value),
      postedAt: str(ld.datePosted),
      ...(str(ld.validThrough) === undefined ? {} : { expiresAt: str(ld.validThrough) }),
      compensation: compensationOf(details.public_compensation),
      experience: [],
      extras,
    };
  },
};
