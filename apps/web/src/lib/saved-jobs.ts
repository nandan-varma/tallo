import type { JobSummary } from "@tallo/contracts";

const nullableStrings = [
  "locationText",
  "city",
  "region",
  "countryCode",
  "department",
  "employmentType",
] as const;
const nullableNumbers = ["postedAt", "salaryMinAnnual", "salaryMaxAnnual", "expMinYears"] as const;

function isJobSummary(value: unknown): value is JobSummary {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  if (!Number.isSafeInteger(job.id) || Number(job.id) <= 0) return false;
  if (!["title", "company", "companySlug", "excerpt"].every((key) => typeof job[key] === "string"))
    return false;
  if (typeof job.sortAt !== "number" || !Number.isFinite(job.sortAt)) return false;
  if (!nullableStrings.every((key) => job[key] === null || typeof job[key] === "string"))
    return false;
  if (
    !nullableNumbers.every(
      (key) => job[key] === null || (typeof job[key] === "number" && Number.isFinite(job[key])),
    )
  )
    return false;
  if (job.workMode !== null && !["remote", "hybrid", "onsite"].includes(String(job.workMode)))
    return false;
  if (
    job.salaryCurrency !== null &&
    (typeof job.salaryCurrency !== "string" || !/^[a-z]{3}$/i.test(job.salaryCurrency))
  )
    return false;
  return [job.url, job.applyUrl].every((value) => {
    if (value === null) return true;
    if (typeof value !== "string") return false;
    try {
      return ["https:", "http:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });
}

/** Stored data can be stale or edited; never trust it as a typed API response. */
export function readSavedJobs(raw: string | null): JobSummary[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) return [];
    const jobs = value.filter(isJobSummary);
    return [...new Map(jobs.map((job) => [job.id, job])).values()];
  } catch {
    return [];
  }
}
