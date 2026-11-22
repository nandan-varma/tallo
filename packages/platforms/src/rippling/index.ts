import type { Money, PayInterval, Platform } from "@tallo/contracts";
import { arr, id, num, obj, str } from "@tallo/contracts";
import { describe, locations, lookup, requireKey, rows, SchemaError, workModeOf } from "../kit.ts";

const API = "https://ats.rippling.com/api";
const PAGE = 500;
/** A board is far below this; the cap only stops a runaway pagination loop. */
const MAX_PAGES = 200;

const INTERVALS: Record<string, PayInterval> = {
  YEAR: "year",
  MONTH: "month",
  WEEK: "week",
  DAY: "day",
  HOUR: "hour",
};

export const rippling: Platform = {
  id: "rippling",
  version: 1,
  hosts: ["ats.rippling.com"],
  validate: (source) => requireKey(source),

  async *list(source, ctx) {
    const seen = new Set<string>();
    let total = 0;
    for (let page = 0, pages = 1; page < pages; page++) {
      if (page >= MAX_PAGES)
        throw new SchemaError(`Rippling ${source.key} paged past ${MAX_PAGES}`);
      const { data } = await ctx.http.getJson(
        `${API}/v2/board/${source.key}/jobs?page=${page}&pageSize=${PAGE}`,
      );
      const body = obj(data);
      const totalPages = num(body.totalPages);
      const totalItems = num(body.totalItems);
      if (totalPages === undefined || totalItems === undefined)
        throw new SchemaError("Rippling listing without totalPages/totalItems");
      pages = totalPages;
      total = totalItems;
      for (const job of rows(body.items, "items")) {
        const jobId = id(job.id);
        if (!jobId) throw new SchemaError("Rippling posting without id");
        if (seen.has(jobId)) continue;
        seen.add(jobId);
        yield { id: jobId, listing: job };
      }
    }
    // Postings opened or closed while paging can shift rows between pages; then the listing is not whole.
    // An unknown board answers 404 (an error), so an empty board is really empty.
    return { complete: seen.size >= total, emptyIsAuthoritative: true };
  },

  /** The listing has no description; the posting endpoint does (and the pay bands). */
  async detail(source, posting, ctx) {
    return (
      await ctx.http.getJson(`${API}/v1/board/${source.key}/jobs/${encodeURIComponent(posting.id)}`)
    ).data;
  },

  map({ id: postingId, listing, detail }) {
    const j = lookup(detail, listing);
    const description = obj(j("description"));
    const places = arr(obj(listing).locations).map((l) => {
      const loc = obj(l);
      return {
        text: loc.name,
        hints: {
          city: str(loc.city),
          region: str(loc.state),
          country: str(loc.country),
          countryCode: str(loc.countryCode),
        },
      };
    });
    const modes = new Set(
      arr(obj(listing).locations).map((l) => workModeOf(obj(l).workplaceType) ?? "none"),
    );
    const mode = modes.size === 1 ? [...modes][0] : undefined;
    const compensation: Money[] = arr(j("payRangeDetails")).flatMap((band) => {
      const b = obj(band);
      const min = num(b.rangeStart);
      const max = num(b.rangeEnd);
      if (min === undefined && max === undefined) return [];
      return [
        {
          min,
          max,
          currency: str(b.currency),
          interval: INTERVALS[str(b.frequency)?.toUpperCase() ?? ""] ?? "unknown",
          component: "base" as const,
          region: str(b.location),
        },
      ];
    });
    const employment = obj(j("employmentType"));
    const department = obj(j("department"));
    const tree = arr(department.department_tree).flatMap((d) => str(d) ?? []);
    return {
      postingId,
      title: str(j("name")) ?? "",
      url: str(j("url")),
      description: describe(description.role, description.company),
      locations: locations(places),
      workMode: mode === "none" ? undefined : mode,
      department: str(obj(obj(listing).department).name) ?? str(department.name),
      employmentType: str(employment.id) ?? str(employment.label),
      postedAt: str(j("createdOn")),
      compensation,
      experience: [],
      extras: {
        ...(tree.length > 1 ? { departmentTree: tree } : {}),
        ...(str(obj(listing).language) ? { language: str(obj(listing).language) } : {}),
      },
    };
  },
};
