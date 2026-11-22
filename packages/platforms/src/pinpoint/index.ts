import type { Money, PayInterval, Platform } from "@tallo/contracts";
import { id, num, obj, str } from "@tallo/contracts";
import { describe, htmlText, locations, requireKey, rows, workModeOf } from "../kit.ts";

const INTERVALS: Record<string, PayInterval> = {
  year: "year",
  annual: "year",
  month: "month",
  week: "week",
  day: "day",
  hour: "hour",
};

/** The ad sections the board states, in page order, each with the header the employer chose. */
const SECTIONS = ["description", "key_responsibilities", "skills_knowledge_expertise", "benefits"];

export const pinpoint: Platform = {
  id: "pinpoint",
  version: 2,
  hosts: ["*.pinpointhq.com"],
  validate: (source) => requireKey(source, /^[a-z0-9][a-z0-9-]*$/),

  /** One request returns every posting with its full ad. */
  async *list(source, ctx) {
    const { data } = await ctx.http.getJson(`https://${source.key}.pinpointhq.com/postings.json`);
    for (const job of rows(obj(data).data, "data")) yield { id: id(job.id) ?? "", listing: job };
    // An unknown tenant answers 404 (an error), so an empty answer means no openings.
    return { complete: true, emptyIsAuthoritative: true };
  },

  map({ id: postingId, listing }) {
    const j = obj(listing);
    const job = obj(j.job);
    const loc = obj(j.location);
    const html = SECTIONS.flatMap((key) => {
      const body = str(j[key]);
      if (!body) return [];
      const header = str(j[`${key}_header`]);
      return [`${header ? `<h3>${htmlText(header)}</h3>` : ""}${body}`];
    });
    const min = num(j.compensation_minimum);
    const max = num(j.compensation_maximum);
    const compensation: Money[] =
      j.compensation_visible !== false &&
      (min !== undefined || max !== undefined || str(j.compensation))
        ? [
            {
              min,
              max,
              currency: str(j.compensation_currency),
              interval: INTERVALS[str(j.compensation_frequency)?.toLowerCase() ?? ""] ?? "unknown",
              component: "base",
              text: str(j.compensation),
            },
          ]
        : [];
    const group = obj(job.structure_custom_group_one);
    return {
      postingId,
      title: str(j.title) ?? "",
      url: str(j.url),
      description: describe(...html),
      locations: locations([
        {
          text: loc.name,
          hints: { city: str(loc.city), region: str(loc.province) },
        },
      ]),
      workMode: workModeOf(j.workplace_type),
      department: str(obj(job.department).name),
      team: str(obj(job.division).name),
      employmentType: str(j.employment_type_text) ?? str(j.employment_type),
      requisitionId: str(job.requisition_id),
      expiresAt: str(j.deadline_at),
      compensation,
      experience: [],
      extras: {
        ...(str(group.name) ? { customGroup: str(group.name) } : {}),
        ...(str(group.title) ? { customGroupTitle: str(group.title) } : {}),
        ...(str(j.reporting_to) ? { reportingTo: str(j.reporting_to) } : {}),
      },
    };
  },
};
