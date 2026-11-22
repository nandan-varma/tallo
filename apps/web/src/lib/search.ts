import { type Money, SEARCH_RESULT_CAP, type SearchSort, type SearchSpec } from "@tallo/contracts";

/** The form's fields, as typed. Several titles, companies or places are separated by commas. */
export interface SearchValues {
  title: string;
  company: string;
  location: string;
  /** Two-letter ISO codes, comma separated. */
  country: string;
  /** "recent" to order by date, empty for relevance. */
  sort: "" | SearchSort;
  /** A whole number of days, as typed. */
  postedWithin: string;
}

/** Splits a comma list into the entries the search accepts: trimmed, too-short entries dropped, capped. */
export function splitList(value: string, max: number, maxChars: number, minChars = 2): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim().slice(0, maxChars))
    .filter((entry) => entry.length >= minChars)
    .slice(0, max);
}

/** Every value of one field, joined for display: `?title=a&title=b` reads as "a, b", not "a". */
function fieldFrom(params: URLSearchParams, name: string): string {
  return params
    .getAll(name)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join(", ")
    .slice(0, 300);
}

/** The fields from a query string. Unknown keys are ignored; nothing here is trusted beyond its shape. */
export function valuesFrom(params: URLSearchParams): SearchValues {
  const sort = params.get("sort");
  const days = Number.parseInt(params.get("postedWithin") ?? "", 10);
  return {
    title: fieldFrom(params, "title"),
    company: fieldFrom(params, "company"),
    location: fieldFrom(params, "location"),
    country: fieldFrom(params, "country"),
    sort: sort === "recent" ? "recent" : "",
    postedWithin: Number.isInteger(days) && days >= 1 && days <= 365 ? String(days) : "",
  };
}

/** The page offset from the query string: a whole number, clamped to the results cap. */
export function offsetFrom(params: URLSearchParams): number {
  const n = Number.parseInt(params.get("offset") ?? "0", 10);
  return Number.isInteger(n) ? Math.min(Math.max(n, 0), SEARCH_RESULT_CAP - 1) : 0;
}

/** Two-letter codes only: the API matches ISO 3166-1 alpha-2 and ignores anything else. */
function countriesOf(value: string): string[] {
  return splitList(value, 8, 2, 2)
    .filter((code) => /^[a-z]{2}$/i.test(code))
    .map((code) => code.toUpperCase());
}

/**
 * The search for these fields, or null when there is neither a title nor a company to search for: the API refuses
 * a query without one, and asking for only a place would silently match the whole catalog.
 */
export function specFrom(values: SearchValues): SearchSpec | null {
  const queries = splitList(values.title, 8, 80);
  const companies = splitList(values.company, 4, 80);
  if (queries.length === 0 && companies.length === 0) return null;
  const locations = splitList(values.location, 8, 60);
  const countries = countriesOf(values.country);
  const days = Number.parseInt(values.postedWithin, 10);
  return {
    queries,
    ...(companies.length > 0 ? { companies } : {}),
    ...(locations.length > 0 ? { locations } : {}),
    ...(countries.length > 0 ? { countries } : {}),
    ...(Number.isInteger(days) && days >= 1 && days <= 365 ? { postedWithin: days } : {}),
    ...(values.sort === "recent" ? { sort: "recent" as const } : {}),
  };
}

/** The results URL for these fields at an offset. Empty fields and the first page are left out of the URL. */
export function searchHref(values: SearchValues, offset = 0): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) if (value) params.set(name, value);
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

/** Only web links leave the site as hrefs; a source's stated link is never trusted as a scheme. */
export function safeHref(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** "posted 3 days ago" from an ISO date, for a reader deciding whether a posting is fresh. */
export function postedAgo(iso: string, now = Date.now()): string | null {
  const then = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  const days = Math.floor((now - then) / 86_400_000);
  if (days < 0) return null;
  if (days === 0) return "posted today";
  if (days === 1) return "posted yesterday";
  if (days < 30) return `posted ${days} days ago`;
  if (days < 365) {
    const months = Math.round(days / 30);
    return `posted ${months} ${months === 1 ? "month" : "months"} ago`;
  }
  const years = Math.floor(days / 365);
  return `posted ${years} ${years === 1 ? "year" : "years"} ago`;
}

/** Format the first stated base-pay band in its own currency and interval. */
export function formatPay(compensation: Money[]): string | null {
  const band = compensation.find(
    (b) =>
      !b.inferred &&
      b.component === "base" &&
      b.interval !== "once" &&
      b.interval !== "unknown" &&
      (b.min !== undefined || b.max !== undefined),
  );
  if (!band) return null;
  const amount = (n: number) => n.toLocaleString("en-US");
  const range =
    band.min !== undefined && band.max !== undefined
      ? band.min === band.max
        ? amount(band.min)
        : `${amount(band.min)}–${amount(band.max)}`
      : band.min !== undefined
        ? `${amount(band.min)}+`
        : `up to ${amount(band.max!)}`;
  const period = {
    hour: "an hour",
    day: "a day",
    week: "a week",
    month: "a month",
    year: "a year",
    once: "",
    unknown: "",
  }[band.interval];
  return [band.currency, range, period, band.region ? `(${band.region})` : null]
    .filter(Boolean)
    .join(" ");
}
