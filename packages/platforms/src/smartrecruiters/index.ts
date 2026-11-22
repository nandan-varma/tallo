import type { Platform, RawPosting } from "@tallo/contracts";
import { arr, id, num, obj, str } from "@tallo/contracts";
import { describe, locations, lookup, pairs, requireKey, rows } from "../kit.ts";

const API = "https://api.smartrecruiters.com/v1/companies";
const PAGE = 100;
const SECTIONS = [
  "companyDescription",
  "jobDescription",
  "qualifications",
  "additionalInformation",
];

export const smartrecruiters: Platform = {
  id: "smartrecruiters",
  version: 3,
  hosts: ["api.smartrecruiters.com"],
  validate: (source) => requireKey(source),

  async *list(source, ctx) {
    let received = 0;
    let total = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < total; offset += PAGE) {
      const { data } = await ctx.http.getJson(
        `${API}/${source.key}/postings?limit=${PAGE}&offset=${offset}`,
      );
      const page = rows(obj(data).content, "content");
      total = num(obj(data).totalFound) ?? offset + page.length;
      received += page.length;
      for (const job of page) yield { id: id(job.id) ?? "", listing: job } satisfies RawPosting;
      if (page.length === 0) break;
    }
    // An empty or short page before `totalFound` is reached means rows were missed: never close on it.
    // Unknown companies answer 200 with totalFound 0.
    return { complete: received >= total, emptyIsAuthoritative: false };
  },

  /** The listing is thin; the job ad sections only exist on the posting endpoint. */
  async detail(source, posting, ctx) {
    return (
      await ctx.http.getJson(`${API}/${source.key}/postings/${encodeURIComponent(posting.id)}`)
    ).data;
  },

  map({ id: postingId, listing, detail }) {
    const j = lookup(detail, listing);
    const sections = obj(obj(j("jobAd")).sections);
    const loc = obj(j("location"));
    const html = SECTIONS.flatMap((key) => {
      const section = obj(sections[key]);
      return str(section.text) ? [`<h3>${str(section.title) ?? ""}</h3>${str(section.text)}`] : [];
    });
    return {
      postingId,
      title: str(j("name")) ?? "",
      url: str(j("postingUrl")),
      applyUrl: str(j("applyUrl")),
      description: describe(...html),
      locations: locations([
        {
          text: loc.fullLocation ?? loc.city,
          hints: {
            city: str(loc.city),
            region: str(loc.region),
            countryCode: str(loc.country)?.toUpperCase(),
            remote: loc.remote === true || undefined,
          },
        },
      ]),
      workMode: loc.remote === true ? "remote" : loc.hybrid === true ? "hybrid" : undefined,
      department: str(obj(j("department")).label),
      team: str(obj(j("function")).label),
      employmentType: str(obj(j("typeOfEmployment")).label),
      requisitionId: str(j("refNumber")),
      postedAt: str(j("releasedDate")),
      expiresAt: str(j("unpublishOn")),
      compensation: [],
      experience: [],
      extras: {
        ...(str(obj(j("experienceLevel")).label)
          ? { experienceLevel: str(obj(j("experienceLevel")).label) }
          : {}),
        ...(str(obj(j("industry")).label) ? { industry: str(obj(j("industry")).label) } : {}),
        ...(arr(j("customField")).length
          ? { customFields: pairs(j("customField"), "fieldLabel", "valueLabel") }
          : {}),
        ...(str(obj(j("language")).code) ? { language: str(obj(j("language")).code) } : {}),
      },
    };
  },
};
