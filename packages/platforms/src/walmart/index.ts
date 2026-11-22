import type { Json, JsonObject, Money, Platform, RawPosting } from "@tallo/contracts";
import { arr, isObject, num, obj, str } from "@tallo/contracts";
import { describe, locations, lookup, SchemaError } from "../kit.ts";

/**
 * Walmart careers (careers.walmart.com, covering Walmart, Sam's Club and Walmart Global Tech). The
 * site's search API and `/results` are disallowed by robots.txt, so this reads only what it allows:
 * `sitemap.xml` lists every posting page (`/us/en/jobs/R-<id>`, no dates) and each page embeds the full
 * record in `__NEXT_DATA__` (`pageProps.jobDetails`). The listing is therefore ids only and the detail
 * call fetches the page, once per new posting.
 */
const HOST = "https://careers.walmart.com";
const SITEMAP = `${HOST}/sitemap.xml`;
const JOB_URL = /<loc>https:\/\/careers\.walmart\.com\/us\/en\/jobs\/(R-\d{1,12})<\/loc>/g;
const NEXT_DATA = /<script id="?__NEXT_DATA__"?[^>]*>(.*?)<\/script>/s;

const stated = (value: unknown): Json | undefined =>
  value === null || value === undefined || value === "" ? undefined : (value as Json);

const named = (value: unknown): string | undefined => str(obj(value).value);

const nonEmpty = (value: unknown): Json | undefined =>
  Array.isArray(value) && value.length > 0 ? (value as Json) : undefined;

function pay(details: (key: string) => unknown): Money[] {
  const plan = obj(details("payPlanData"));
  const currency = str(obj(plan.currencyReference).currencyId);
  const frequency = named(plan.frequency) ?? str(details("payFrequency"));
  const interval =
    frequency === "Hourly" ? "hour" : frequency === "Annual" ? "year" : ("unknown" as const);
  const out: Money[] = [];
  for (const range of arr(details("payRange")).map(obj)) {
    const min = num(Number(range.min));
    const max = num(Number(range.max));
    if (min === undefined && max === undefined) continue;
    out.push({
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(currency ? { currency } : {}),
      interval,
      component: "base",
    });
  }
  return out;
}

export const walmart: Platform = {
  id: "walmart",
  version: 1,
  hosts: ["careers.walmart.com"],
  validate(source) {
    if (source.key !== "walmart")
      throw new Error(`Walmart source key must be walmart: ${source.key}`);
  },

  async *list(_source, ctx) {
    const xml = (await ctx.http.getText(SITEMAP)).data;
    if (!xml.includes("<urlset")) throw new SchemaError("Walmart sitemap is not a urlset");
    const seen = new Set<string>();
    for (const match of xml.matchAll(JOB_URL)) {
      const id = match[1] as string;
      if (seen.has(id)) continue;
      seen.add(id);
      yield { id, listing: { id, url: `${HOST}/us/en/jobs/${id}` } } satisfies RawPosting;
      if (seen.size >= ctx.maxPostings) {
        ctx.record({ code: "budget", message: `Stopped at ${ctx.maxPostings} postings` });
        return { complete: false, emptyIsAuthoritative: false };
      }
    }
    // The sitemap is a snapshot; a closed requisition leaves it. An empty one proves nothing.
    return { complete: true, emptyIsAuthoritative: false };
  },

  async detail(_source, posting, ctx) {
    const html = (await ctx.http.getText(`${HOST}/us/en/jobs/${posting.id}`)).data;
    const raw = NEXT_DATA.exec(html)?.[1];
    if (!raw) throw new SchemaError(`Walmart job ${posting.id} page without __NEXT_DATA__`);
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new SchemaError(`Walmart job ${posting.id} __NEXT_DATA__ is not JSON`);
    }
    const page = obj(obj(obj(data).props).pageProps);
    if (!isObject(page.jobDetails))
      throw new SchemaError(`Walmart job ${posting.id} page without jobDetails`);
    return { jobDetails: page.jobDetails } as JsonObject;
  },

  map({ id: postingId, detail }) {
    const root = lookup(detail);
    const d = lookup(root("jobDetails"));
    const place = obj(d("primaryLocation"));
    const places = [place, ...arr(d("additionalLocations")).map(obj)].filter(
      (p) => str(p.city) || str(p.stateCode),
    );
    const extras: JsonObject = {};
    const put = (key: string, value: Json | undefined) => {
      if (value !== undefined) extras[key] = value;
    };
    put("brand", stated(d("brand")));
    put("populationType", stated(d("populationType")));
    put("requisitionStatus", stated(named(d("requisitionStatus"))));
    put("jobProfile", stated(named(d("jobProfile"))));
    put("businessSegment", stated(named(d("businessSegment"))));
    put("workerType", stated(named(d("positionWorkerType"))));
    put("positionAvailable", stated(d("positionAvailable")));
    put("minimumQualification", nonEmpty(d("minimumQualification")));
    put("preferredQualification", nonEmpty(d("preferredQualification")));
    put("profileMapping", stated(d("profileMapping")));
    put("storeNumber", stated(place.storeNumber));
    const url = `${HOST}/us/en/jobs/${postingId}`;
    const profile = obj(d("profileMapping"));
    return {
      postingId,
      title: str(d("jobPostingTitle")) ?? str(d("title")) ?? "",
      url,
      applyUrl: url,
      description: describe(d("description") ?? d("jobPostingDescription")),
      locations: locations(
        places.map((p) => {
          const [city, region, country] = [str(p.city), str(p.stateCode), str(p.countryCode)];
          return {
            text: [city, region, country].filter(Boolean).join(", "),
            hints: { city, region, country },
          };
        }),
      ),
      department: Object.keys(profile)[0],
      employmentType: str(obj(arr(d("employmentTypes")).map(obj)[0]).value),
      requisitionId: str(d("jobId")),
      postedAt: str(d("jobPostingStartDate")),
      updatedAt: str(d("effectiveDate")),
      compensation: pay(d),
      experience: [],
      extras,
    };
  },
};
