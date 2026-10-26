import type { JobLocation, JobSummary, Money, PayInterval, Quantity } from "@tallo/contracts";

/** Plain en-US digits for counts. */
export const number = new Intl.NumberFormat("en-US");

const money = (n: number, currency: string | null) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency ?? "USD",
    maximumFractionDigits: 0,
    notation: n >= 10000 ? "compact" : "standard",
  }).format(n);

export function salary(
  job: Pick<JobSummary, "salaryMinAnnual" | "salaryMaxAnnual" | "salaryCurrency">,
): string | null {
  const { salaryMinAnnual: min, salaryMaxAnnual: max, salaryCurrency: c } = job;
  if (min === null && max === null) return null;
  if (min === null || max === null || min === max) return `${money((max ?? min)!, c)} / yr`;
  return `${money(min, c)} – ${money(max, c)} / yr`;
}

/** Relative age in coarse units ("just now", "5m ago", "3d ago", "2mo ago"). Null when unknown. */
export function ago(epochSeconds: number | null, now = Date.now() / 1000): string | null {
  if (epochSeconds === null) return null;
  const seconds = Math.max(0, now - epochSeconds);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86400);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export const experience = (years: number | null): string | null =>
  years === null ? null : years === 0 ? "No experience required" : `${years}+ yrs`;

/** Primary location first; otherwise source order. */
export const sortLocations = (locations: JobLocation[]): JobLocation[] =>
  [...locations].sort((a, b) => Number(b.primary === true) - Number(a.primary === true));

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `term` appears in `text` as a whole word, not as a fragment of a longer word. */
function mentions(text: string, term: string, caseInsensitive: boolean): boolean {
  const word = "[\\p{L}\\p{N}]";
  const pattern = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?!${word})`,
    `u${caseInsensitive ? "i" : ""}`,
  );
  return pattern.test(text);
}

/**
 * The location text, with the country appended unless the text already names it.
 * A country name matches case-insensitively; a bare ISO code must match exactly (so "US" is
 * not found inside "BUSINESS" or "us" inside "campus").
 */
export function formatLocation(location: JobLocation): string {
  const country = location.country ?? location.countryCode;
  if (!country) return location.text;
  const isName = location.country !== undefined;
  return mentions(location.text, country, isName) ? location.text : `${location.text}, ${country}`;
}

const INTERVAL_LABEL: Record<PayInterval, string> = {
  year: "/ yr",
  month: "/ mo",
  week: "/ wk",
  day: "/ day",
  hour: "/ hr",
  once: "one-time",
  unknown: "",
};

const COMPONENT_LABEL: Record<Money["component"], string> = {
  base: "Base",
  bonus: "Bonus",
  equity: "Equity",
  total: "Total comp",
  unknown: "",
};

const plain = (n: number, currency?: string): string => {
  const code = currency && /^[a-z]{3}$/i.test(currency) ? currency.toUpperCase() : undefined;
  return code
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: code,
        maximumFractionDigits: 0,
      }).format(n)
    : n.toLocaleString("en-US");
};

/**
 * "$120,000 – $150,000 / yr · Base · US". A min-only band reads "from $90,000", a max-only band
 * "up to $5,000", and an exact amount (min = max) reads as a single figure.
 * Empty when the band has no amount.
 */
export function formatPay(band: Money): string {
  const { min, max, currency } = band;
  let amount = "";
  if (min !== undefined && max !== undefined) {
    amount =
      min === max ? plain(min, currency) : `${plain(min, currency)} – ${plain(max, currency)}`;
  } else if (min !== undefined) {
    amount = `from ${plain(min, currency)}`;
  } else if (max !== undefined) {
    amount = `up to ${plain(max, currency)}`;
  }
  const head = [amount, INTERVAL_LABEL[band.interval]].filter(Boolean).join(" ");
  return [head, COMPONENT_LABEL[band.component], band.region].filter(Boolean).join(" · ");
}

/** "3+ years", "2–5 years", "up to 4 years", "1 year". Never invents a range. */
export function formatQuantity(q: Quantity): string {
  const unit = (n: number) => (n === 1 ? q.unit.replace(/s$/, "") : q.unit);
  if (q.exact !== undefined) return `${q.exact} ${unit(q.exact)}`;
  if (q.min !== undefined && q.max !== undefined) return `${q.min}–${q.max} ${q.unit}`;
  if (q.min !== undefined) return `${q.min}+ ${unit(q.min)}`;
  if (q.max !== undefined) return `up to ${q.max} ${unit(q.max)}`;
  return "";
}

export const KIND_LABEL: Record<Quantity["kind"], string> = {
  required: "Required",
  preferred: "Preferred",
  stated: "",
};

/** "team_size" -> "Team size". */
const extraLabel = (key: string): string => {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Flattens a source extra value to display text. Arrays join; objects stay as JSON. */
export function formatExtra(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(formatExtra).filter(Boolean).join(", ");
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Extras as [label, text] rows, dropping empty values. */
export const extraRows = (extras: Record<string, unknown>): [string, string][] =>
  Object.entries(extras)
    .map(([key, value]): [string, string] => [extraLabel(key), formatExtra(value)])
    .filter(([, value]) => value !== "");
