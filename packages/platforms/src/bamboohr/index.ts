import type { Platform } from "@tallo/contracts";
import { id, num, obj, str } from "@tallo/contracts";
import { describe, locations, lookup, requireKey, rows, SchemaError } from "../kit.ts";

const base = (key: string) => `https://${key}.bamboohr.com/careers`;

/** The tenant is a subdomain, so the key may not contain dots or underscores. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export const bamboohr: Platform = {
  id: "bamboohr",
  version: 1,
  hosts: ["*.bamboohr.com"],
  validate: (source) => requireKey(source, KEY),

  async *list(source, ctx) {
    const { data } = await ctx.http.getJson(`${base(source.key)}/list`);
    const body = obj(data);
    const result = rows(body.result, "result");
    const total = num(obj(body.meta).totalCount);
    if (total === undefined) throw new SchemaError("Missing meta.totalCount");
    for (const job of result) yield { id: id(job.id) ?? "", listing: job };
    // The list is a single unpaged answer; a count that disagrees means we did not see all of it.
    // An existing tenant with no openings answers 200 with an empty result; unknown tenants redirect.
    return { complete: total === result.length, emptyIsAuthoritative: true };
  },

  /** The list has no description; it only exists on the per-posting endpoint. */
  async detail(source, posting, ctx) {
    const { data } = await ctx.http.getJson(
      `${base(source.key)}/${encodeURIComponent(posting.id)}/detail`,
    );
    const opening = obj(obj(obj(data).result).jobOpening);
    if (!str(opening.jobOpeningName)) throw new SchemaError("Missing result.jobOpening");
    return obj(data).result ?? null;
  },

  map({ id: postingId, listing, detail }) {
    const opening = obj(obj(detail).jobOpening);
    const j = lookup(opening, listing);
    const loc = obj(j("location"));
    const ats = obj(j("atsLocation"));
    const city = str(loc.city) ?? str(ats.city);
    const region = str(loc.state) ?? str(ats.state) ?? str(ats.province);
    const country = str(loc.addressCountry) ?? str(ats.country);
    const place = [city, region, country].filter(Boolean).join(", ");
    const remote = j("isRemote") === true;
    return {
      postingId,
      title: str(j("jobOpeningName")) ?? "",
      url: str(j("jobOpeningShareUrl")),
      description: describe(j("description")),
      locations: locations([
        {
          text: place || (remote ? "Remote" : undefined),
          hints: {
            city,
            region,
            country,
            remote: remote || undefined,
          },
        },
      ]),
      workMode: remote ? "remote" : undefined,
      department: str(j("departmentLabel")),
      employmentType: str(j("employmentStatusLabel")),
      postedAt: str(j("datePosted")),
      compensation: [],
      experience: [],
      extras: {
        ...(str(j("employmentType")) ? { employmentTypeCode: str(j("employmentType")) } : {}),
        ...(str(j("locationType")) ? { locationType: str(j("locationType")) } : {}),
        // Free text ("$130,000"): stated, but with no currency or interval, so not typed pay.
        ...(str(j("compensation")) ? { compensationText: str(j("compensation")) } : {}),
        // A level label ("Experienced"), not a number of years, so not typed experience.
        ...(str(j("minimumExperience")) ? { experienceLevel: str(j("minimumExperience")) } : {}),
        ...(str(j("jobOpeningStatus")) ? { status: str(j("jobOpeningStatus")) } : {}),
      },
    };
  },
};
