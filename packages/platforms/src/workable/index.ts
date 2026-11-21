import type { Platform } from "@tallo/contracts";
import { arr, id, obj, str } from "@tallo/contracts";
import { describe, locations, lookup, requireKey, rows, SchemaError } from "../kit.ts";

export const workable: Platform = {
  id: "workable",
  version: 1,
  hosts: ["apply.workable.com"],
  validate: (source) => requireKey(source),

  /**
   * The public widget returns every open posting with its description in one response; there is
   * no paging, so one request is the whole board. An unknown account answers 404 (the http layer
   * throws), but a real account with nothing open answers 200 with an empty list, so empty is
   * not treated as proof either way.
   */
  async *list(source, ctx) {
    const { data } = await ctx.http.getJson(
      `https://apply.workable.com/api/v1/widget/accounts/${source.key}?details=true`,
    );
    if (typeof data !== "object" || data === null || Array.isArray(data))
      throw new SchemaError("Expected object at widget response");
    for (const job of rows((data as Record<string, unknown>).jobs, "jobs"))
      yield { id: id(job.shortcode) ?? "", listing: job };
    return { complete: true, emptyIsAuthoritative: false };
  },

  map({ id: postingId, listing }) {
    const j = lookup(listing);
    const remote = j("telecommuting") === true;
    const places = arr(j("locations"))
      .map(obj)
      // `hidden` only hides the place from the careers page; the source still states it.
      .map((l) => ({
        text: [str(l.city), str(l.region), str(l.country)].filter(Boolean).join(", "),
        hints: {
          city: str(l.city) || undefined,
          region: str(l.region) || undefined,
          country: str(l.country) || undefined,
          countryCode: str(l.countryCode) || undefined,
          ...(remote ? { remote: true } : {}),
        },
      }));
    const text = (key: string) => str(j(key)) || undefined;
    return {
      postingId,
      title: str(j("title")) ?? "",
      url: str(j("url")),
      applyUrl: str(j("application_url")),
      description: describe(j("description")),
      locations: locations(places),
      workMode: remote ? "remote" : undefined,
      department: text("department"),
      employmentType: text("employment_type"),
      requisitionId: text("code"),
      postedAt: str(j("published_on")),
      compensation: [],
      experience: [],
      extras: {
        ...(text("function") ? { function: text("function") as string } : {}),
        ...(text("industry") ? { industry: text("industry") as string } : {}),
        ...(text("education") ? { education: text("education") as string } : {}),
        ...(text("experience") ? { experience: text("experience") as string } : {}),
      },
    };
  },
};
