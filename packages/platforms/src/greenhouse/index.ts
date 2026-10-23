import { arr, id, obj, str } from "@tallo/contracts";
import type { Money, Platform, SourceConfig } from "@tallo/contracts";
import { describe, guessInterval, locations, pairs, requireKey, rows, workModeOf } from "../kit.ts";

const base = (s: SourceConfig) =>
  `https://${s.params.region === "eu" ? "boards-api.eu.greenhouse.io" : "boards-api.greenhouse.io"}/v1/boards/${s.key}/jobs`;

/** Pay ranges are cents with a free-text title ("Annual Salary:"); the interval is in the title. */
function pay(ranges: unknown): Money[] {
  return arr(ranges).flatMap((r) => {
    const { min_cents, max_cents, currency_type, title } = obj(r);
    const min = typeof min_cents === "number" ? min_cents / 100 : undefined;
    const max = typeof max_cents === "number" ? max_cents / 100 : undefined;
    if (min === undefined && max === undefined) return [];
    const label = str(title) ?? "";
    const interval = /hour/i.test(label) ? "hour" : /annual|year/i.test(label) ? "year" : guessInterval(max ?? min ?? 0);
    return [{ min, max, currency: str(currency_type), interval, component: "base" as const, text: label || undefined }];
  });
}

export const greenhouse: Platform = {
  id: "greenhouse",
  version: 1,
  hosts: ["boards-api.greenhouse.io", "boards-api.eu.greenhouse.io"],
  validate: (source) => requireKey(source),

  async *list(source, ctx) {
    const { data } = await ctx.http.getJson(`${base(source)}?content=true`);
    for (const job of rows(obj(data).jobs, "jobs")) yield { id: id(job.id) ?? "", listing: job };
    return { complete: true, emptyIsAuthoritative: true };
  },

  /** Pay transparency and application questions only exist on the single-job endpoint. */
  async detail(source, posting, ctx) {
    const url = `${base(source)}/${encodeURIComponent(posting.id)}?questions=true&pay_transparency=true`;
    return (await ctx.http.getJson(url)).data;
  },

  map({ id: postingId, listing, detail }) {
    const j = { ...obj(listing), ...obj(detail) };
    const metadata = pairs(j.metadata, "name", "value");
    const departments = arr(j.departments).map((d) => str(obj(d).name)).filter((n): n is string => !!n);
    const offices = arr(j.offices).map((o) => str(obj(o).location) ?? str(obj(o).name));
    const place = str(obj(j.location).name);
    return {
      postingId,
      title: str(j.title) ?? "",
      url: str(j.absolute_url),
      applyUrl: str(j.absolute_url),
      description: describe(j.content),
      locations: locations([{ text: place }, ...offices.map((text) => ({ text }))]),
      workMode: workModeOf(metadata["Workplace Type"]) ?? workModeOf(metadata["Work Type"]),
      department: departments[0],
      employmentType: str(metadata["Employment Type"]) ?? str(metadata["Job Type"]),
      requisitionId: str(j.requisition_id),
      postedAt: str(j.first_published),
      updatedAt: str(j.updated_at),
      expiresAt: str(j.application_deadline),
      compensation: pay(j.pay_input_ranges),
      experience: [],
      extras: {
        departments,
        ...(Object.keys(metadata).length ? { metadata } : {}),
        ...(j.education ? { education: j.education } : {}),
        ...(j.language ? { language: j.language } : {}),
        ...(j.internal_job_id ? { internalJobId: j.internal_job_id } : {}),
      },
    };
  },
};
