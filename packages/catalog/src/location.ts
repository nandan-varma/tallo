import type { JobLocation, WorkMode } from "@tallo/contracts";
import countries from "i18n-iso-countries";
import en from "i18n-iso-countries/langs/en.json" with { type: "json" };

countries.registerLocale(en);

const US_STATES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia",
};
const US_STATE_NAMES = new Map(
  Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]),
);

const CA_PROVINCES = new Set([
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
]);

/** Aliases the ISO name tables don't cover. */
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

/** Trailing postal code ("IL 60436-8579"). */
const ZIP = /\s+\d{5}(?:-\d{4})?$/;
const REMOTE = /\b(remote|work from home|wfh|telecommute|distributed|anywhere)\b/i;
const HYBRID = /\bhybrid\b/i;
const ONSITE = /\b(on[- ]?site|in[- ]office|in[- ]person)\b/i;

export function countryCodeFor(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const key = name.trim().toLowerCase().replace(/\.$/, "");
  if (ALIASES[key]) return ALIASES[key];
  if (/^[a-z]{2}$/.test(key))
    return countries.isValid(key.toUpperCase()) ? key.toUpperCase() : undefined;
  return countries.getAlpha2Code(name.trim(), "en");
}

export function detectWorkMode(...texts: (string | undefined)[]): WorkMode | undefined {
  const joined = texts.filter(Boolean).join(" | ");
  if (HYBRID.test(joined)) return "hybrid";
  if (REMOTE.test(joined)) return "remote";
  if (ONSITE.test(joined)) return "onsite";
  return undefined;
}

/** Best-effort structure from a free-text place ("Austin, TX", "Remote - US", "Tokyo, Japan"). */
export function parseLocation(text: string, hints: Partial<JobLocation> = {}): JobLocation {
  const clean = text.replace(/\s+/g, " ").trim();
  const loc: JobLocation = { text: clean, ...hints };
  loc.countryCode ??= countryCodeFor(loc.country);
  if (REMOTE.test(clean) && loc.remote === undefined) loc.remote = true;
  const parts = clean
    .replace(/\((.*?)\)/g, ", $1")
    .split(/[,|/–—]| - /)
    .map((p) => p.replace(REMOTE, "").replace(HYBRID, "").replace(ZIP, "").trim())
    .filter(Boolean);

  for (let i = parts.length - 1; i >= 0 && !loc.countryCode; i--) {
    const part = parts[i]!;
    // A bare two-letter part after a city is a US state or Canadian province before it is a country
    // ("Joliet, IL" is Illinois, not Israel).
    if (
      part.length === 2 &&
      (US_STATES[part.toUpperCase()] || CA_PROVINCES.has(part.toUpperCase()))
    )
      continue;
    const code = countryCodeFor(part);
    if (code && (part.length > 2 || part === part.toUpperCase())) {
      loc.countryCode = code;
      loc.country ??= part;
    }
  }
  if (!loc.countryCode) {
    for (const part of parts) {
      const upper = part.toUpperCase();
      if (US_STATES[upper] || US_STATE_NAMES.has(part.toLowerCase())) {
        loc.countryCode = "US";
        loc.region ??= US_STATES[upper] ?? part;
        break;
      }
      if (CA_PROVINCES.has(upper)) {
        loc.countryCode = "CA";
        loc.region ??= part;
        break;
      }
    }
  } else if (loc.countryCode === "US" && !loc.region) {
    for (const part of parts) {
      const upper = part.toUpperCase();
      if (US_STATES[upper]) loc.region = US_STATES[upper];
      else if (US_STATE_NAMES.has(part.toLowerCase())) loc.region = part;
    }
  }
  // The first part is the city unless it is a street address, a country or "remote".
  const city = parts.find((p) => !/^\d/.test(p));
  if (!loc.city && parts.length > 1 && city && city === parts[0] && !countryCodeFor(city))
    loc.city = city;
  return loc;
}

/** Tri-state: 1 = in the US, 0 = definitely elsewhere, null = unknown (remote, ambiguous). */
export function usFlag(locations: JobLocation[]): 0 | 1 | null {
  if (locations.some((l) => l.countryCode === "US")) return 1;
  const known = locations.filter((l) => l.countryCode);
  if (known.length > 0 && known.length === locations.length) return 0;
  return null;
}
