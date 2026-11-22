import type { Platform } from "@tallo/contracts";
import { arr, id, obj, str } from "@tallo/contracts";
import { describe, locations, requireKey, rows, workModeOf } from "../kit.ts";

export const gem: Platform = {
  id: "gem",
  version: 1,
  hosts: ["api.gem.com"],
  // Board names are the company's own vanity path; one (`-joinforage`) starts with a hyphen.
  validate: (source) => requireKey(source, /^[\w.-]+$/),

  /** One request returns every posting with its full description. */
  async *list(source, ctx) {
    const { data } = await ctx.http.getJson(
      `https://api.gem.com/job_board/v0/${source.key}/job_posts/`,
    );
    for (const job of rows(data, "job_posts")) yield { id: id(job.id) ?? "", listing: job };
    // An unknown board answers 404 (an error), so an empty answer means no openings.
    return { complete: true, emptyIsAuthoritative: true };
  },

  map({ id: postingId, listing }) {
    const j = obj(listing);
    const departments = arr(j.departments).flatMap((d) => str(obj(d).name) ?? []);
    return {
      postingId,
      title: str(j.title) ?? "",
      url: str(j.absolute_url),
      description: describe(j.content) || str(j.content_plain) || "",
      locations: locations([
        { text: obj(j.location).name },
        ...arr(j.offices).map((o) => ({ text: obj(obj(o).location).name })),
      ]),
      workMode: workModeOf(j.location_type),
      department: departments[0],
      employmentType: str(j.employment_type),
      requisitionId: str(j.requisition_id),
      postedAt: str(j.first_published_at),
      updatedAt: str(j.updated_at),
      compensation: [],
      experience: [],
      extras: {
        ...(departments.length > 1 ? { departments } : {}),
      },
    };
  },
};
