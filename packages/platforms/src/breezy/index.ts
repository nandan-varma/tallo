import type { Json, JsonObject, Money, PayInterval, Platform } from "@tallo/contracts";
import { arr, id, num, obj, str } from "@tallo/contracts";
import { parse } from "node-html-parser";
import {
  describe,
  jobPostingLd,
  locations,
  lookup,
  requireKey,
  rows,
  SchemaError,
  workModeOf,
} from "../kit.ts";

const INTERVALS: Record<string, PayInterval> = {
  YEAR: "year",
  MONTH: "month",
  WEEK: "week",
  DAY: "day",
  HOUR: "hour",
};

const host = (key: string) => `https://${key}.breezy.hr`;

/** The schema.org JobPosting a Breezy job page publishes for search engines (not every portal does). */
function jobPostingOf(html: string): Json {
  return jobPostingLd(parse(html)) ?? null;
}

export const breezy: Platform = {
  id: "breezy",
  version: 2,
  hosts: ["*.breezy.hr"],
  validate: (source) => requireKey(source, /^[a-z0-9][a-z0-9-]*$/),

  async *list(source, ctx) {
    // `verbose` adds each posting's description to the feed: one request for the whole board.
    const { data } = await ctx.http.getJson(`${host(source.key)}/json?verbose=true`);
    for (const job of rows(data, "positions")) yield { id: id(job.id) ?? "", listing: job };
    // An unknown portal answers 404 (an error), so an empty answer means no openings.
    return { complete: true, emptyIsAuthoritative: true };
  },

  /**
   * Only the job page's JSON-LD states pay as numbers (the feed has a display string), so the page is
   * fetched only for a posting whose feed row states a salary.
   */
  async detail(source, posting, ctx): Promise<JsonObject> {
    const listing = obj(posting.listing);
    if (!str(listing.salary)) return {};
    const slug = str(listing.friendly_id);
    if (!slug) throw new SchemaError("Breezy position without friendly_id");
    const html = (await ctx.http.getText(`${host(source.key)}/p/${encodeURIComponent(slug)}`)).data;
    return { jobPosting: jobPostingOf(html) };
  },

  map({ id: postingId, listing, detail }) {
    const l = obj(listing);
    const page = lookup(detail);
    const posting = obj(page("jobPosting"));
    const places = arr(l.locations).length ? arr(l.locations) : [l.location];
    const primary = obj(l.location);
    const modeText = obj(primary.remote_details).value;
    const salary = obj(posting.baseSalary);
    const amount = obj(salary.value);
    const min = num(amount.minValue);
    const max = num(amount.maxValue);
    const compensation: Money[] =
      min !== undefined || max !== undefined
        ? [
            {
              min,
              max,
              currency: str(salary.currency),
              interval: INTERVALS[str(amount.unitText)?.toUpperCase() ?? ""] ?? "unknown",
              component: "base",
              text: str(l.salary),
            },
          ]
        : [];
    return {
      postingId,
      title: str(l.name) ?? str(posting.title) ?? "",
      url: str(l.url),
      description: describe(l.description ?? posting.description),
      locations: locations(
        places.map((p) => {
          const loc = obj(p);
          return {
            text: loc.name,
            hints: {
              city: str(loc.city),
              region: str(obj(loc.state).name),
              country: str(obj(loc.country).name),
              countryCode: str(obj(loc.country).id),
              remote: loc.is_remote === true || undefined,
            },
          };
        }),
      ),
      workMode: workModeOf(modeText) ?? (primary.is_remote === true ? "remote" : undefined),
      department: str(l.department),
      employmentType: str(obj(l.type).name),
      postedAt: str(l.published_date),
      expiresAt: str(posting.validThrough),
      compensation,
      experience: [],
      extras: {
        ...(str(posting.employmentType)
          ? { schemaEmploymentType: str(posting.employmentType) }
          : {}),
        ...(str(obj(primary.remote_details).label)
          ? { remoteDetails: str(obj(primary.remote_details).label) }
          : {}),
      },
    };
  },
};
