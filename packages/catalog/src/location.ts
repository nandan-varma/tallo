import type { JobLocation } from "@tallo/contracts";
import countries from "i18n-iso-countries";
import en from "i18n-iso-countries/langs/en.json" with { type: "json" };

countries.registerLocale(en);

/** Country names the ISO name tables do not cover, as sources write them. */
const ALIASES: Record<string, string> = {
  usa: "US",
  us: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  america: "US",
  "united states of america": "US",
  uk: "GB",
  "u.k.": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  "great britain": "GB",
  uae: "AE",
  korea: "KR",
  "south korea": "KR",
  "czech republic": "CZ",
  czechia: "CZ",
  "the netherlands": "NL",
  deutschland: "DE",
  türkiye: "TR",
  turkey: "TR",
  "hong kong": "HK",
  "puerto rico": "PR",
  russia: "RU",
};

/** ISO 3166-1 alpha-2 for a country the source named (a code or an English name). Undefined when unknown. */
function countryCodeFor(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const key = name.trim().toLowerCase().replace(/\.$/, "");
  if (ALIASES[key]) return ALIASES[key];
  if (/^[a-z]{2}$/.test(key))
    return countries.isValid(key.toUpperCase()) ? key.toUpperCase() : undefined;
  return countries.getAlpha2Code(name.trim(), "en");
}

/**
 * A place as the source stated it: its own text plus the structured fields the source gave (city, region,
 * country, remote, primary). Nothing is parsed out of the text, so a place with no structured fields stays
 * unknown. A country name only becomes a code through the ISO tables.
 */
export function sourceLocation(text: string, hints: Partial<JobLocation> = {}): JobLocation {
  const countryCode = hints.countryCode ?? countryCodeFor(hints.country);
  return {
    ...hints,
    text: text.replace(/\s+/g, " ").trim(),
    ...(countryCode ? { countryCode } : {}),
  };
}
