import type { Json, JsonObject, Platform } from "@tallo/contracts";
import { isObject, str } from "@tallo/contracts";
import { XMLParser } from "fast-xml-parser";
import { describe, locations, lookup, requireKey, SchemaError, workModeOf } from "../kit.ts";

/**
 * Jobvite's public careers feed: `Xml.aspx?c=<company id>` returns every open posting, description
 * included, in one response. The company id (`q` + 7 characters) is the board key; it is the `c=` value of
 * the careers page's own links (`getCompanyId()` / `companyEId` in the page source).
 */
const parser = new XMLParser({
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === "job",
});

/** `MM/DD/YYYY` (the feed's stated format) to `YYYY-MM-DD`; anything else is not guessed at. */
function feedDate(value: unknown): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str(value) ?? "");
  if (!m) return undefined;
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  return d.toISOString().slice(0, 10);
}

export const jobvite: Platform = {
  id: "jobvite",
  version: 1,
  hosts: ["app.jobvite.com"],
  validate: (source) => requireKey(source, /^[A-Za-z0-9]{6,16}$/),

  async *list(source, ctx) {
    const url = `https://app.jobvite.com/CompanyJobs/Xml.aspx?c=${source.key}`;
    const { data } = await ctx.http.getText(url);
    let doc: unknown;
    try {
      doc = parser.parse(data);
    } catch (e) {
      throw new SchemaError(`Jobvite feed is not XML: ${(e as Error).message}`);
    }
    if (!isObject(doc) || !("result" in doc))
      throw new SchemaError("Expected a <result> root element in the Jobvite feed");
    // An empty feed is `<result />` (parsed as ""); a feed with postings is an object holding `job`s.
    const result = doc.result;
    let jobs: Json[] = [];
    if (result !== "") {
      if (!isObject(result) || !Array.isArray(result.job))
        throw new SchemaError("Expected <job> elements inside <result>");
      jobs = result.job;
    }
    for (const job of jobs) {
      if (!isObject(job) || !str(job.id)) throw new SchemaError("Jobvite <job> without an <id>");
      yield { id: str(job.id) as string, listing: job as JsonObject };
    }
    // One response is the whole board. An unknown company id also answers 200 `<result />`.
    return { complete: true, emptyIsAuthoritative: false };
  },

  map({ id, listing }) {
    const j = lookup(listing);
    const department = str(j("department"));
    const category = str(j("category"));
    return {
      postingId: id,
      title: str(j("title")) ?? "",
      url: str(j("detail-url")),
      applyUrl: str(j("apply-url")),
      description: describe(j("description") ?? j("briefdescription")),
      locations: locations([{ text: j("location") }]),
      workMode: workModeOf(j("remote_x0020_type")),
      department: department ?? category,
      employmentType: str(j("jobtype")),
      requisitionId: str(j("requisitionid")),
      postedAt: feedDate(j("date")),
      compensation: [],
      experience: [],
      extras: {
        ...(str(j("region")) ? { region: str(j("region")) } : {}),
        // Group boards (e.g. Internet Brands) name the brand a posting belongs to.
        ...(str(j("company")) ? { company: str(j("company")) } : {}),
        ...(str(j("remote_x0020_type")) ? { remoteType: str(j("remote_x0020_type")) } : {}),
        ...(department && category ? { category } : {}),
        ...(str(j("parentId")) ? { parentId: str(j("parentId")) } : {}),
        ...(str(j("externalJobPostingId"))
          ? { externalJobPostingId: str(j("externalJobPostingId")) }
          : {}),
      },
    };
  },
};
