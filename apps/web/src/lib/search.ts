import { SEARCH_RESULT_CAP, type SearchSpec } from "@tallo/contracts";

/** The form's fields, as typed. Several titles, companies or places are separated by commas. */
export interface SearchValues {
  title: string;
  company: string;
  location: string;
}

/** Splits a comma list into the entries the search accepts: trimmed, too-short entries dropped, capped. */
export function splitList(value: string, max: number, maxChars: number, minChars = 2): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim().slice(0, maxChars))
    .filter((entry) => entry.length >= minChars)
    .slice(0, max);
}

/** The fields from a query string. Unknown keys are ignored; nothing here is trusted beyond its shape. */
export function valuesFrom(params: URLSearchParams): SearchValues {
  const field = (name: string) => (params.get(name) ?? "").slice(0, 300);
  return { title: field("title"), company: field("company"), location: field("location") };
}

/** The page offset from the query string: a whole number, clamped to the results cap. */
export function offsetFrom(params: URLSearchParams): number {
  const n = Number.parseInt(params.get("offset") ?? "0", 10);
  return Number.isInteger(n) ? Math.min(Math.max(n, 0), SEARCH_RESULT_CAP - 1) : 0;
}

/** The search for these fields, or null when there is no title to search for. */
export function specFrom(values: SearchValues): SearchSpec | null {
  const queries = splitList(values.title, 8, 80);
  if (queries.length === 0) return null;
  const companies = splitList(values.company, 4, 80);
  const locations = splitList(values.location, 8, 60);
  return {
    queries,
    ...(companies.length > 0 ? { companies } : {}),
    ...(locations.length > 0 ? { locations } : {}),
  };
}

/** The results URL for these fields at an offset. Empty fields and the first page are left out of the URL. */
export function searchHref(values: SearchValues, offset = 0): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) if (value) params.set(name, value);
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  return query ? `/search?${query}` : "/search";
}

/** Only web links leave the site as hrefs; a source's stated link is never trusted as a scheme. */
export function safeHref(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}
