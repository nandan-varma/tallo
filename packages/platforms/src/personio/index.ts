import type {
  CollectContext,
  Json,
  JsonObject,
  Money,
  PayInterval,
  Platform,
  Quantity,
} from "@tallo/contracts";
import { arr, id, isObject, obj, str } from "@tallo/contracts";
import { XMLParser } from "fast-xml-parser";
import { describe, locations, lookup, requireKey, SchemaError } from "../kit.ts";

/**
 * Personio's public XML feed: one request per board returns every position with its fields. The feed
 * answers in the board's default language; a position without a description in that language has an empty
 * `jobDescriptions`, and the English feed (`?language=en`) may carry it. `detail` reads that feed (once per
 * run and board) only for such postings. The `.de` host serves every board, `.com` ones included.
 */
const feedUrl = (key: string, language?: string) =>
  `https://${key}.jobs.personio.de/xml${language ? `?language=${language}` : ""}`;

const parser = new XMLParser({
  parseTagValue: false, // keep ids and numbers as the strings the feed states
  isArray: (name) => ["position", "office", "jobDescription"].includes(name),
});

function positions(xml: unknown, label: string): JsonObject[] {
  if (typeof xml !== "string") throw new SchemaError(`Expected XML text at ${label}`);
  let root: JsonObject;
  try {
    root = parser.parse(xml) as JsonObject;
  } catch (e) {
    throw new SchemaError(`Unparseable XML at ${label}: ${(e as Error).message}`);
  }
  if (!("workzag-jobs" in root)) throw new SchemaError(`No <workzag-jobs> element at ${label}`);
  // An empty feed parses to "" rather than an object.
  const feed = root["workzag-jobs"];
  const list = isObject(feed) ? (feed.position ?? []) : feed === "" ? [] : null;
  if (!Array.isArray(list) || !list.every(isObject))
    throw new SchemaError(`Unexpected <position> shape at ${label}`);
  for (const p of list as JsonObject[])
    if (!id(p.id)) throw new SchemaError(`Position without id at ${label}`);
  return list as JsonObject[];
}

/** The main office, then the additional ones. */
function offices(j: (k: string) => Json | undefined): string[] {
  const more = obj(j("additionalOffices")).office;
  return [...arr(j("office")), ...arr(more)].flatMap((o) => (str(o) ? [str(o) as string] : []));
}

/** `yearsOfExperience` is a closed set of bands. An unknown code stays in the raw payload. */
const EXPERIENCE: Record<string, { min?: number; max?: number }> = {
  "lt-1": { max: 1 },
  "1-2": { min: 1, max: 2 },
  "2-5": { min: 2, max: 5 },
  "5-7": { min: 5, max: 7 },
  "7-10": { min: 7, max: 10 },
  "gt-10": { min: 10 },
};

/** `salaryInformation.type`. Anything else stays `unknown`. */
const INTERVALS: Record<string, PayInterval> = {
  yearly: "year",
  monthly: "month",
  weekly: "week",
  daily: "day",
  hourly: "hour",
};

/** The feed states amounts as decimal strings ("3500.00"). */
const amount = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
};

const englishFeeds = new WeakMap<CollectContext, Map<string, Promise<JsonObject[]>>>();

export const personio: Platform = {
  id: "personio",
  version: 1,
  hosts: ["*.jobs.personio.de", "*.jobs.personio.com"],
  validate: (source) => requireKey(source, /^[a-z0-9][a-z0-9-]*$/i),

  async *list(source, ctx) {
    const { data } = await ctx.http.getText(feedUrl(source.key));
    for (const job of positions(data, "workzag-jobs")) yield { id: id(job.id) ?? "", listing: job };
    // An unknown board answers 404 (an error). A 200 with no positions may be a board whose feed is off
    // or empty, so an empty answer proves nothing.
    return { complete: true, emptyIsAuthoritative: false };
  },

  /** Only for a posting without a description in the default language: look in the English feed. */
  async detail(source, posting, ctx): Promise<JsonObject> {
    if (obj(posting.listing).jobDescriptions) return {};
    const byBoard = englishFeeds.get(ctx) ?? new Map<string, Promise<JsonObject[]>>();
    englishFeeds.set(ctx, byBoard);
    let feed = byBoard.get(source.key);
    if (!feed) {
      feed = ctx.http
        .getText(feedUrl(source.key, "en"))
        .then((r) => positions(r.data, "workzag-jobs?language=en"));
      byBoard.set(source.key, feed);
    }
    const found = (await feed).find((p) => id(p.id) === posting.id)?.jobDescriptions;
    return found ? { jobDescriptions: found } : {};
  },

  map({ id: postingId, listing, detail }, source) {
    const j = lookup(detail, listing);
    const sections = arr(obj(j("jobDescriptions")).jobDescription).map(
      (s) => `<h3>${str(obj(s).name) ?? ""}</h3>${str(obj(s).value) ?? ""}`,
    );
    const band = EXPERIENCE[str(j("yearsOfExperience")) ?? ""];
    const experience: Quantity[] = band
      ? [
          {
            min: band.min,
            max: band.max,
            unit: "years",
            kind: "stated",
            text: str(j("yearsOfExperience")),
          },
        ]
      : [];
    const salary = obj(j("salaryInformation"));
    const min = amount(salary.min);
    const max = amount(salary.max);
    const compensation: Money[] =
      min !== undefined || max !== undefined
        ? [
            {
              min,
              max,
              currency: str(salary.currencyCode),
              interval: INTERVALS[str(salary.type) ?? ""] ?? "unknown",
              component: "base",
            },
          ]
        : [];
    const extra = (key: string) => (str(j(key)) ? { [key]: str(j(key)) as string } : {});
    return {
      postingId,
      title: str(j("name")) ?? "",
      url: `https://${source.key}.jobs.personio.de/job/${postingId}`,
      description: describe(...sections),
      locations: locations(offices(j).map((text) => ({ text }))),
      department: str(j("department")),
      employmentType: str(j("employmentType")),
      postedAt: str(j("createdAt")),
      compensation,
      experience,
      extras: {
        ...extra("seniority"),
        ...extra("schedule"),
        ...extra("recruitingCategory"),
        ...extra("occupation"),
        ...extra("occupationCategory"),
        ...extra("keywords"),
        ...extra("subcompany"),
      },
    };
  },
};
