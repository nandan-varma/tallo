import type { JobLocation, Json, Money, PayInterval, Platform } from "@tallo/contracts";
import { arr, id, num, obj, str } from "@tallo/contracts";
import { describe, locations, requireKey, rows, workModeOf } from "../kit.ts";

const COMPONENT: Record<string, Money["component"]> = {
  Salary: "base",
  Bonus: "bonus",
  Commission: "bonus",
  EquityPercentage: "equity",
  EquityCashValue: "equity",
};

/** "1 YEAR" | "1 HOUR" | "NONE" */
const interval = (v: unknown): PayInterval => {
  const unit = str(v)?.split(" ")[1]?.toLowerCase();
  return unit === "year" || unit === "month" || unit === "week" || unit === "day" || unit === "hour"
    ? unit
    : "unknown";
};

function compensation(value: Json | undefined): Money[] {
  return arr(obj(value).compensationTiers).flatMap((tier) =>
    arr(obj(tier).components).flatMap((c) => {
      const { compensationType, minValue, maxValue, currencyCode, interval: iv, summary } = obj(c);
      const min = num(minValue);
      const max = num(maxValue);
      if (min === undefined && max === undefined) return [];
      return [
        {
          min,
          max,
          currency: str(currencyCode),
          interval: interval(iv),
          component: COMPONENT[str(compensationType) ?? ""] ?? "unknown",
          region: str(obj(tier).title),
          text: str(summary),
        },
      ];
    }),
  );
}

const place = (
  text: unknown,
  address: Json | undefined,
): { text: unknown; hints: Partial<JobLocation> } => {
  const a = obj(obj(address).postalAddress);
  return {
    text,
    hints: {
      city: str(a.addressLocality),
      region: str(a.addressRegion),
      country: str(a.addressCountry),
    },
  };
};

export const ashby: Platform = {
  id: "ashby",
  version: 1,
  hosts: ["api.ashbyhq.com"],
  validate: (source) => requireKey(source),

  async *list(source, ctx) {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${source.key}?includeCompensation=true`;
    const { data } = await ctx.http.getJson(url);
    for (const job of rows(obj(data).jobs, "jobs")) {
      if (job.isListed !== false) yield { id: id(job.id) ?? "", listing: job };
    }
    return { complete: true, emptyIsAuthoritative: true };
  },

  map({ id: postingId, listing }) {
    const j = obj(listing);
    const secondary = arr(j.secondaryLocations).map((l) => place(obj(l).location, obj(l).address));
    const comp = obj(j.compensation);
    return {
      postingId,
      title: str(j.title) ?? "",
      url: str(j.jobUrl),
      applyUrl: str(j.applyUrl),
      description: describe(j.descriptionHtml) || str(j.descriptionPlain) || "",
      locations: locations([place(j.location, j.address), ...secondary]),
      workMode: workModeOf(j.workplaceType) ?? (j.isRemote === true ? "remote" : undefined),
      department: str(j.department),
      team: str(j.team),
      employmentType: str(j.employmentType),
      postedAt: str(j.publishedAt),
      compensation: compensation(j.compensation),
      experience: [],
      extras: {
        ...(str(comp.compensationTierSummary)
          ? { compensationSummary: str(comp.compensationTierSummary) }
          : {}),
        ...(j.shouldDisplayCompensationOnJobPostings === false ? { compensationHidden: true } : {}),
      },
    };
  },
};
