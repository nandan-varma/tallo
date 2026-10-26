import type { SavedSearch, SearchSpec } from "@tallo/contracts";

const norm = (items: string[] | undefined) =>
  [...new Set((items ?? []).map((item) => item.trim().toLowerCase()))].sort();

/** Two searches are the same when they ask for the same titles in the same places, whatever the order or case. */
export function sameSpec(a: SearchSpec, b: SearchSpec): boolean {
  return (
    JSON.stringify([norm(a.queries), norm(a.locations)]) ===
    JSON.stringify([norm(b.queries), norm(b.locations)])
  );
}

const titleCase = (text: string) => text.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());

/** A short name for a search: its first title phrase, then its first place. */
export function specName(spec: SearchSpec): string {
  const title = titleCase(spec.queries[0]?.trim() ?? "Search");
  const place = spec.locations?.[0]?.trim();
  return place ? `${title} · ${titleCase(place)}` : title;
}

/** "3 new", "30+ new", or nothing when there is nothing new. */
export function newLabel(search: Pick<SavedSearch, "newCount" | "newCapped">): string | null {
  if (search.newCount === 0) return null;
  return `${search.newCount}${search.newCapped ? "+" : ""} new`;
}

export const findSaved = (saved: SavedSearch[], spec: SearchSpec | null) =>
  spec ? saved.find((search) => sameSpec(search.spec, spec)) : undefined;
