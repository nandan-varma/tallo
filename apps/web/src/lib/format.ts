import type { JobLocation, JobSummary, Money, PayInterval, Quantity } from "@tallo/contracts";

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

export function ago(epochSeconds: number | null, now = Date.now() / 1000): string | null {
  if (epochSeconds === null) return null;
  const days = Math.floor((now - epochSeconds) / 86400);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export const experience = (years: number | null): string | null =>
  years === null ? null : years === 0 ? "No experience required" : `${years}+ yrs`;

/** Primary location first; otherwise source order. */
export const sortLocations = (locations: JobLocation[]): JobLocation[] =>
  [...locations].sort((a, b) => Number(b.primary === true) - Number(a.primary === true));

/** The location text, with the country appended unless the text already names it. */
export function formatLocation(location: JobLocation): string {
  const country = location.country ?? location.countryCode;
  return country && !location.text.includes(country)
    ? `${location.text}, ${country}`
    : location.text;
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

/** "$120,000 – $150,000 / yr · Base · US". Empty when the band has no amount. */
export function formatPay(band: Money): string {
  const { min, max, currency } = band;
  const single = min ?? max;
  const amount =
    min !== undefined && max !== undefined && min !== max
      ? `${plain(min, currency)} – ${plain(max, currency)}`
      : single === undefined
        ? ""
        : plain(single, currency);
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
export const extraLabel = (key: string): string => {
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
