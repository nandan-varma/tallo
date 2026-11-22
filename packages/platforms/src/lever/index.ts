import type { Money, PayInterval, Platform, SourceConfig } from "@tallo/contracts";
import { arr, id, num, obj, str } from "@tallo/contracts";
import { describe, isoFromMs, locations, requireKey, rows, workModeOf } from "../kit.ts";

const host = (s: SourceConfig) => (s.params.region === "eu" ? "api.eu.lever.co" : "api.lever.co");

const INTERVALS: Record<string, PayInterval> = {
  "per-year-salary": "year",
  "per-month-salary": "month",
  "per-week-wage": "week",
  "per-day-wage": "day",
  "per-hour-wage": "hour",
  "one-time": "once",
};

export const lever: Platform = {
  id: "lever",
  version: 3,
  hosts: ["api.lever.co", "api.eu.lever.co"],
  validate: (source) => requireKey(source),

  async *list(source, ctx) {
    const { data } = await ctx.http.getJson(
      `https://${host(source)}/v0/postings/${source.key}?mode=json`,
    );
    for (const job of rows(data, "postings")) yield { id: id(job.id) ?? "", listing: job };
    // An unknown board answers 404 (an error), so a 200 with [] is a board that exists and has no postings.
    return { complete: true, emptyIsAuthoritative: true };
  },

  map({ id: postingId, listing }) {
    const j = obj(listing);
    const categories = obj(j.categories);
    const lists = arr(j.lists).map(
      (l) => `<h3>${str(obj(l).text) ?? ""}</h3><ul>${str(obj(l).content) ?? ""}</ul>`,
    );
    const range = obj(j.salaryRange);
    const compensation: Money[] =
      num(range.min) !== undefined || num(range.max) !== undefined
        ? [
            {
              min: num(range.min),
              max: num(range.max),
              currency: str(range.currency),
              interval: INTERVALS[str(range.interval) ?? ""] ?? "unknown",
              component: "base",
            },
          ]
        : [];
    const places = arr(categories.allLocations).length
      ? arr(categories.allLocations)
      : [categories.location];
    // `country` is one code for the posting, so it hints the primary place only.
    const countryCode = str(j.country);
    const placeTexts = places.flatMap((text) => {
      const stated = str(text);
      return stated ? [stated] : [];
    });
    return {
      postingId,
      title: str(j.text) ?? "",
      url: str(j.hostedUrl),
      applyUrl: str(j.applyUrl),
      description: describe(j.description, ...lists, j.additional),
      locations: locations(
        placeTexts.map((text, index) => ({ text, hints: index === 0 ? { countryCode } : {} })),
      ),
      workMode: workModeOf(j.workplaceType),
      department: str(categories.department),
      team: str(categories.team),
      employmentType: str(categories.commitment),
      postedAt: isoFromMs(j.createdAt),
      compensation,
      experience: [],
      extras: {
        ...(str(j.salaryDescriptionPlain)
          ? { salaryDescription: str(j.salaryDescriptionPlain) }
          : {}),
        ...(str(categories.level) ? { level: str(categories.level) } : {}),
      },
    };
  },
};
