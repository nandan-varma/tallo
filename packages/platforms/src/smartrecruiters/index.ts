import { arr, id, num, obj, str } from "@tallo/contracts";
import type { Platform, RawPosting } from "@tallo/contracts";
import { describe, locations, pairs, requireKey, rows } from "../kit.ts";

const API = "https://api.smartrecruiters.com/v1/companies";
const PAGE = 100;
const SECTIONS = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"];

export const smartrecruiters: Platform = {
  id: "smartrecruiters",
  version: 1,
  hosts: ["api.smartrecruiters.com"],
  validate: (source) => requireKey(source),

  async *list(source, ctx) {
    for (let offset = 0, total = Number.POSITIVE_INFINITY; offset < total; offset += PAGE) {
      const { data } = await ctx.http.getJson(`${API}/${source.key}/postings?limit=${PAGE}&offset=${offset}`);
      const page = rows(obj(data).content, "content");
      total = num(obj(data).totalFound) ?? offset + page.length;
      for (const job of page) yield { id: id(job.id) ?? "", listing: job } satisfies RawPosting;
      if (page.length === 0) break;
    }
    // Unknown companies answer 200 with totalFound 0.
    return { complete: true, emptyIsAuthoritative: false };
  },

  /** The listing is thin; the job ad sections only exist on the posting endpoint. */
  async detail(source, posting, ctx) {
    return (await ctx.http.getJson(`${API}/${source.key}/postings/${encodeURIComponent(posting.id)}`)).data;
  },

  map({ id: postingId, listing, detail }) {
    const j = { ...obj(listing), ...obj(detail) };
    const sections = obj(obj(j.jobAd).sections);
    const loc = obj(j.location);
    const html = SECTIONS.flatMap((key) => {
      const section = obj(sections[key]);
      return str(section.text) ? [`<h3>${str(section.title) ?? ""}</h3>${str(section.text)}`] : [];
    });
    return {
      postingId,
      title: str(j.name) ?? "",
      url: str(j.postingUrl),
      applyUrl: str(j.applyUrl),
      description: describe(...html),
      locations: locations([{ text: loc.fullLocation ?? loc.city, hints: { city: str(loc.city), region: str(loc.region), countryCode: str(loc.country)?.toUpperCase(), remote: loc.remote === true || undefined } }]),
      workMode: loc.remote === true ? "remote" : loc.hybrid === true ? "hybrid" : undefined,
      department: str(obj(j.department).label),
      team: str(obj(j.function).label),
      employmentType: str(obj(j.typeOfEmployment).label),
      requisitionId: str(j.refNumber),
      postedAt: str(j.releasedDate),
      compensation: [],
      experience: [],
      extras: {
        ...(str(obj(j.experienceLevel).label) ? { experienceLevel: str(obj(j.experienceLevel).label) } : {}),
        ...(str(obj(j.industry).label) ? { industry: str(obj(j.industry).label) } : {}),
        ...(arr(j.customField).length ? { customFields: pairs(j.customField, "fieldLabel", "valueLabel") } : {}),
        ...(str(obj(j.language).code) ? { language: str(obj(j.language).code) } : {}),
      },
    };
  },
};
