import type { JsonObject, Platform, SourceConfig, WorkMode } from "@tallo/contracts";
import { arr, id, num, obj, str } from "@tallo/contracts";
import { describe, locations, lookup, requireKey, rows, SchemaError } from "../kit.ts";

const API = "https://explore.jobs.netflix.net/api/apply/v2/jobs";
/** The public board answers at most 10 rows per request, whatever `num` asks for. */
const PAGE = 10;
/** Netflix's Eightfold domain. The API answers 404 for a domain it does not know. */
const DOMAIN = "netflix.com";

const WORK_MODES: Record<string, WorkMode> = {
  onsite: "onsite",
  remote: "remote",
  remotelocal: "remote",
  remoteglobal: "remote",
  hybrid: "hybrid",
};

/** Netflix's own Work Type values, reduced to their punctuation-free form. */
function workModeOf(value: unknown): WorkMode | undefined {
  const normalized = str(value)
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  return normalized ? WORK_MODES[normalized] : undefined;
}

const pageUrl = (source: SourceConfig, start: number) =>
  `${API}?domain=${encodeURIComponent(source.key)}&start=${start}&num=${PAGE}`;

/** Netflix states t_create/t_update in epoch seconds. */
const isoFromSeconds = (value: unknown): string | undefined => {
  const seconds = num(value);
  return seconds === undefined || seconds < 0 ? undefined : new Date(seconds * 1000).toISOString();
};

/**
 * The detail's structured `posting_date` is the date the employer page states (MM-DD-YYYY).
 * `t_create` can be older when a role is reposted, so prefer the stated date when it parses.
 */
const postingDate = (value: unknown): string | undefined => {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(str(value) ?? "");
  if (!m) return undefined;
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return date.toISOString();
};

const firstString = (value: unknown): string | undefined =>
  arr(value)
    .map((item) => str(item))
    .find((item): item is string => item !== undefined);

/** Read the structured custom fields Netflix states in its detail response, without empty values. */
function customFields(value: unknown): JsonObject {
  return Object.fromEntries(
    Object.entries(obj(value))
      .map(([key, field]) => {
        if (Array.isArray(field)) {
          const values = field.filter((item) => item !== null && item !== "");
          return [key, values] as const;
        }
        return [key, field] as const;
      })
      .filter(([, field]) =>
        Array.isArray(field) ? field.length > 0 : field !== null && field !== "",
      ),
  ) as JsonObject;
}

export const netflix: Platform = {
  id: "netflix",
  version: 1,
  hosts: ["explore.jobs.netflix.net"],
  validate(source) {
    requireKey(source);
    if (source.key !== DOMAIN)
      throw new Error(`Netflix source key must be ${DOMAIN}: ${source.key}`);
  },

  async *list(source, ctx) {
    const seen = new Set<string>();
    let total: number | undefined;
    for (let start = 0; ; start += PAGE) {
      const { data } = await ctx.http.getJson(pageUrl(source, start));
      const page = rows(obj(data).positions, "positions");
      const count = num(obj(data).count);
      if (count === undefined || !Number.isInteger(count) || count < 0)
        throw new SchemaError("Netflix listing has no valid count");
      // A count that moves while paging means the result order was not stable. Reading on could
      // silently skip a posting, so the run is incomplete rather than an inferred closure.
      if (total === undefined) total = count;
      else if (count !== total)
        throw new SchemaError(`Netflix listing count changed from ${total} to ${count}`);
      if (page.length > PAGE)
        throw new SchemaError(
          `Netflix page ${start} returned ${page.length} rows, more than ${PAGE}`,
        );

      if (page.length === 0) {
        if (seen.size !== total)
          throw new SchemaError(
            `Netflix listing ended at ${seen.size} of ${total} postings (start ${start})`,
          );
        // The API 404s an unknown domain, so a 200 with count 0 really is an empty board.
        return { complete: true, emptyIsAuthoritative: true };
      }

      for (const job of page) {
        const postingId = id(job.id);
        if (!postingId || !/^\d+$/.test(postingId))
          throw new SchemaError(`Netflix posting at start ${start} has no numeric id`);
        if (seen.has(postingId))
          throw new SchemaError(`Netflix listing repeated posting ${postingId} at start ${start}`);
        seen.add(postingId);
        yield { id: postingId, listing: job };
      }

      if (seen.size > total)
        throw new SchemaError(
          `Netflix listing returned ${seen.size} postings but reported ${total}`,
        );
      if (seen.size === total) return { complete: true, emptyIsAuthoritative: true };
      if (page.length < PAGE)
        throw new SchemaError(
          `Netflix short page at start ${start}: ${seen.size} of ${total} postings`,
        );
    }
  },

  /** The listing carries no description; the job endpoint adds it plus the structured custom fields. */
  async detail(source, posting, ctx) {
    return (
      await ctx.http.getJson(
        `${API}/${encodeURIComponent(posting.id)}?domain=${encodeURIComponent(source.key)}`,
      )
    ).data;
  },

  map({ id: postingId, listing, detail }) {
    const j = lookup(detail, listing);
    const fields = obj(obj(j("custom_JD")).data_fields);
    const custom = customFields(fields);
    const canonical = str(j("canonicalPositionUrl"));
    const team = firstString(fields.team);
    const extras: JsonObject = {
      ...(str(j("business_unit")) ? { businessUnit: str(j("business_unit")) } : {}),
      ...(str(j("type")) ? { sourceType: str(j("type")) } : {}),
      ...(str(j("locale")) ? { locale: str(j("locale")) } : {}),
      ...(str(j("location_flexibility"))
        ? { locationFlexibility: str(j("location_flexibility")) }
        : {}),
      ...(Object.keys(custom).length ? { customFields: custom } : {}),
    };
    return {
      postingId,
      title: str(j("posting_name")) ?? str(j("name")) ?? "",
      url: canonical,
      // Eightfold's canonical job page is the employer's application page (with the apply form).
      applyUrl: canonical,
      description: describe(j("job_description")),
      locations: locations(arr(j("locations")).map((text) => ({ text }))),
      workMode: workModeOf(j("work_location_option")) ?? workModeOf(firstString(fields.work_type)),
      department: str(j("department")) ?? team,
      requisitionId: str(j("ats_job_id")) ?? str(j("display_job_id")),
      postedAt: postingDate(firstString(fields.posting_date)) ?? isoFromSeconds(j("t_create")),
      updatedAt: isoFromSeconds(j("t_update")),
      // Netflix states pay in the description text, not in a structured field.
      compensation: [],
      experience: [],
      extras,
    };
  },
};
