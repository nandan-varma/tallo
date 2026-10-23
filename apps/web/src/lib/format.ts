import type { JobSummary } from "@tallo/contracts";

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
