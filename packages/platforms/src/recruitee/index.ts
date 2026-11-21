import type { Json, Money, PayInterval, Platform, WorkMode } from "@tallo/contracts";
import { arr, id, isObject, obj, str } from "@tallo/contracts";
import { describe, locations, lookup, requireKey, SchemaError } from "../kit.ts";

const INTERVALS: Record<string, PayInterval> = {
  year: "year",
  month: "month",
  week: "week",
  day: "day",
  hour: "hour",
};

/** "2026-10-09 13:26:19 UTC" -> ISO 8601. */
function isoOf(value: unknown): string | undefined {
  const text = str(value);
  const m = text?.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/);
  return m ? `${m[1]}T${m[2]}.000Z` : undefined;
}

/** Amounts arrive as strings ("110000.00"). */
function amount(value: unknown): number | undefined {
  const text = str(value);
  if (text === undefined || text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** A mode only when the source flags exactly one; remote+hybrid together is left to the reader. */
function workModeOf(flags: {
  remote: unknown;
  hybrid: unknown;
  onSite: unknown;
}): WorkMode | undefined {
  const set: WorkMode[] = [];
  if (flags.remote === true) set.push("remote");
  if (flags.hybrid === true) set.push("hybrid");
  if (flags.onSite === true) set.push("onsite");
  return set.length === 1 ? set[0] : undefined;
}

export const recruitee: Platform = {
  id: "recruitee",
  version: 1,
  hosts: ["*.recruitee.com"],
  validate: (source) => requireKey(source, /^[A-Za-z0-9][A-Za-z0-9-]*$/),

  async *list(source, ctx) {
    // One request per board: the public offers feed carries the full description.
    const { data } = await ctx.http.getJson(`https://${source.key}.recruitee.com/api/offers/`);
    const offers = obj(data).offers;
    if (!Array.isArray(offers) || !offers.every(isObject))
      throw new SchemaError("Expected {offers: [...]} from Recruitee");
    for (const offer of offers) yield { id: id(offer.id) ?? "", listing: offer };
    // An unknown board answers 404 (a failed run), so a 200 with no offers is a real empty board.
    return { complete: true, emptyIsAuthoritative: true };
  },

  // `position` is the display order and moves when other postings change.
  fingerprint(listing) {
    const { position: _position, ...rest } = obj(listing);
    return rest;
  },

  map({ id: postingId, listing }) {
    const get = lookup(listing);
    const salary = obj(get("salary"));
    const min = amount(salary.min);
    const max = amount(salary.max);
    const compensation: Money[] =
      min !== undefined || max !== undefined
        ? [
            {
              min,
              max,
              currency: str(salary.currency),
              interval: INTERVALS[str(salary.period) ?? ""] ?? "unknown",
              component: "base",
            },
          ]
        : [];
    const remote = get("remote") === true;
    // Some offers list a place with only state and country; the offer-level fields name the city then.
    const structured = arr(get("locations"));
    const named = structured.every((l) => str(obj(l).name) ?? str(obj(l).city));
    const places =
      structured.length && named
        ? structured.map((l) => ({
            text: str(obj(l).name) ?? str(obj(l).city),
            hints: {
              city: str(obj(l).city),
              region: str(obj(l).state),
              country: str(obj(l).country),
              countryCode: str(obj(l).country_code),
              ...(remote ? { remote: true } : {}),
            },
          }))
        : [
            {
              text: str(get("location")),
              hints: {
                city: str(get("city")),
                region: str(get("state_name")),
                country: str(get("country")),
                countryCode: str(get("country_code")),
                ...(remote ? { remote: true } : {}),
              },
            },
          ];
    const extras: Record<string, Json> = {};
    for (const key of [
      "experience_code",
      "education_code",
      "category_code",
      "min_hours_per_week",
      "max_hours_per_week",
      "slug",
    ]) {
      const value = get(key);
      if (value !== undefined) extras[key] = value;
    }
    const tags = arr(get("tags"));
    if (tags.length) extras.tags = tags;
    return {
      postingId,
      title: str(get("title")) ?? "",
      url: str(get("careers_url")),
      applyUrl: str(get("careers_apply_url")),
      description: describe(get("description"), get("requirements")),
      locations: locations(places),
      workMode: workModeOf({
        remote: get("remote"),
        hybrid: get("hybrid"),
        onSite: get("on_site"),
      }),
      department: str(get("department")),
      employmentType: str(get("employment_type_code")),
      postedAt: isoOf(get("published_at")) ?? isoOf(get("created_at")),
      updatedAt: isoOf(get("updated_at")),
      expiresAt: isoOf(get("close_at")),
      compensation,
      experience: [],
      extras,
    };
  },
};
