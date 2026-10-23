import type { JobLocation, Money, Quantity } from "@tallo/contracts";

/** Typed view of `JobDetail.facts`. Built by `readFacts`, which drops anything malformed. */
export interface JobFacts {
  platform?: string;
  locations: JobLocation[];
  compensation: Money[];
  experience: Quantity[];
  extras: Record<string, unknown>;
}

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const oneOf = <const T extends string>(allowed: readonly T[], v: unknown): T | undefined =>
  allowed.find((a) => a === v);
const list = <T>(v: unknown, read: (item: unknown) => T | undefined): T[] =>
  Array.isArray(v) ? v.map(read).filter((item): item is T => item !== undefined) : [];

const INTERVALS = ["year", "month", "week", "day", "hour", "once", "unknown"] as const;
const COMPONENTS = ["base", "bonus", "equity", "total", "unknown"] as const;
const KINDS = ["required", "preferred", "stated"] as const;
const UNITS = ["years", "months"] as const;

function readLocation(raw: unknown): JobLocation | undefined {
  if (!isRecord(raw)) return undefined;
  const label = text(raw.text);
  if (!label) return undefined;
  return {
    text: label,
    city: text(raw.city),
    region: text(raw.region),
    country: text(raw.country),
    countryCode: text(raw.countryCode),
    remote: raw.remote === true,
    primary: raw.primary === true,
  };
}

function readMoney(raw: unknown): Money | undefined {
  if (!isRecord(raw)) return undefined;
  const min = num(raw.min);
  const max = num(raw.max);
  if (min === undefined && max === undefined) return undefined;
  return {
    min,
    max,
    currency: text(raw.currency),
    interval: oneOf(INTERVALS, raw.interval) ?? "unknown",
    component: oneOf(COMPONENTS, raw.component) ?? "unknown",
    region: text(raw.region),
    text: text(raw.text),
    inferred: raw.inferred === true,
  };
}

function readQuantity(raw: unknown): Quantity | undefined {
  if (!isRecord(raw)) return undefined;
  const unit = oneOf(UNITS, raw.unit);
  const min = num(raw.min);
  const max = num(raw.max);
  const exact = num(raw.exact);
  if (!unit || (min === undefined && max === undefined && exact === undefined)) return undefined;
  return {
    min,
    max,
    exact,
    unit,
    kind: oneOf(KINDS, raw.kind) ?? "stated",
    text: text(raw.text),
    inferred: raw.inferred === true,
  };
}

/** Reads the loosely typed `facts` column. Malformed entries are dropped, never trusted. */
export function readFacts(raw: unknown): JobFacts {
  const f = isRecord(raw) ? raw : {};
  return {
    platform: text(f.platform),
    locations: list(f.locations, readLocation),
    compensation: list(f.compensation, readMoney),
    experience: list(f.experience, readQuantity),
    extras: isRecord(f.extras) ? f.extras : {},
  };
}
