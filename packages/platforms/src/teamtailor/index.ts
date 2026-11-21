import type { Json, JsonObject, Platform, SourceConfig, WorkMode } from "@tallo/contracts";
import { arr, isObject, obj, str } from "@tallo/contracts";
import { XMLParser } from "fast-xml-parser";
import { describe, locations, lookup, requireKey, SchemaError } from "../kit.ts";

/**
 * Teamtailor career sites publish their open jobs as one RSS feed, description included:
 * `https://<key>.teamtailor.com/jobs.rss`. One answer holds at most 100 items (checked live: a board with 112
 * jobs answers 100, and `?offset=100` the other 12), so a full answer is followed by the next `offset`.
 * An unknown subdomain answers 404; a real board with no jobs answers 200 with an empty channel.
 */
const url = (source: SourceConfig, offset: number) =>
  `https://${source.key}.teamtailor.com/jobs.rss${offset ? `?offset=${offset}` : ""}`;

/** Items in a full answer. A shorter answer is the end of the feed. */
const PAGE = 100;

// Text stays text: zip codes keep leading zeros, nothing becomes a number or boolean.
const parser = new XMLParser({
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreAttributes: true,
  isArray: (name) => name === "item" || name === "tt:location",
});

/** Parse a feed into its item objects. Anything that is not an RSS channel is a schema error. */
export function parseFeed(xml: string): JsonObject[] {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new SchemaError(`Teamtailor feed is not XML: ${(e as Error).message}`);
  }
  const channel = obj(obj(doc).rss).channel;
  if (!isObject(channel)) throw new SchemaError("Expected rss.channel in Teamtailor feed");
  const items = channel.item;
  if (items === undefined) return [];
  if (!Array.isArray(items) || !items.every(isObject))
    throw new SchemaError("Expected channel items to be objects");
  return items as JsonObject[];
}

const WORK_MODES: Record<string, WorkMode> = {
  fully: "remote",
  hybrid: "hybrid",
  onsite: "onsite",
};

export const teamtailor: Platform = {
  id: "teamtailor",
  version: 1,
  hosts: ["*.teamtailor.com"],
  validate: (source) => requireKey(source, /^[a-z0-9][a-z0-9-]*$/i),

  async *list(source, ctx) {
    const seen = new Set<string>();
    let offset = 0;
    for (;;) {
      const { data } = await ctx.http.getText(url(source, offset));
      const items = parseFeed(data);
      let fresh = 0;
      for (const item of items) {
        const guid = str(item.guid);
        if (!guid) throw new SchemaError("Teamtailor item without a guid");
        if (seen.has(guid)) continue;
        seen.add(guid);
        fresh++;
        yield { id: guid, listing: item };
      }
      if (items.length < PAGE) break;
      // A full answer that adds nothing new means offset paging is not working: say so, never close on it.
      if (fresh === 0) {
        ctx.record({
          code: "pagination",
          message: `offset ${offset} repeated earlier items`,
          url: url(source, offset),
        });
        return { complete: false, emptyIsAuthoritative: false };
      }
      if (seen.size >= ctx.maxPostings) return { complete: false, emptyIsAuthoritative: false };
      offset += items.length;
    }
    return { complete: true, emptyIsAuthoritative: true };
  },

  map({ id: postingId, listing }) {
    const read = lookup(listing);
    const places = arr(obj(read("tt:locations"))["tt:location"]).map((l) => {
      const loc = lookup(l);
      const city = str(loc("tt:city"));
      const country = str(loc("tt:country"));
      return {
        text: [city, country].filter(Boolean).join(", ") || str(loc("tt:name")),
        hints: { city, country },
      };
    });
    const role = str(read("tt:role"));
    const division = str(read("tt:division"));
    const extras: Record<string, Json> = {};
    if (role) extras.role = role;
    if (division) extras.division = division;
    const companyName = str(read("company_name"));
    if (companyName) extras.companyName = companyName;
    const companyUuid = str(read("company_uuid"));
    if (companyUuid) extras.companyUuid = companyUuid;
    return {
      postingId,
      title: str(read("title")) ?? "",
      url: str(read("link")),
      description: describe(read("description")),
      locations: locations(places),
      workMode: WORK_MODES[str(read("remoteStatus")) ?? ""],
      department: str(read("tt:department")),
      postedAt: rfc822(str(read("pubDate"))),
      compensation: [],
      experience: [],
      extras,
    };
  },
};

/** RFC 822 date (`Mon, 16 Nov 2026 10:25:07 +0100`) to ISO; undefined when it does not parse. */
function rfc822(value: string | undefined): string | undefined {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
