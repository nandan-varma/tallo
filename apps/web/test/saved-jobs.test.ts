import type { JobSummary } from "@tallo/contracts";
import { describe, expect, it } from "vitest";
import { readSavedJobs } from "../src/lib/saved-jobs.ts";

const job: JobSummary = {
  id: 42,
  title: "Senior Product Engineer",
  company: "Example Company",
  companySlug: "example-company",
  locationText: "Remote",
  city: null,
  region: null,
  countryCode: "US",
  workMode: "remote",
  department: "Product",
  employmentType: "Full-time",
  postedAt: 1_700_000_000,
  salaryMinAnnual: 150_000,
  salaryMaxAnnual: 200_000,
  salaryCurrency: "USD",
  expMinYears: 5,
  excerpt: "Build thoughtful products with a small team.",
  sortAt: 1_700_000_000,
  applyUrl: "https://example.com/careers",
  url: "https://example.com/jobs/42",
};
const secondJob: JobSummary = {
  ...job,
  id: 43,
  title: "Product Designer",
  applyUrl: null,
  url: null,
};

describe("saved jobs", () => {
  it("restores valid jobs and deduplicates their IDs", () => {
    expect(readSavedJobs(JSON.stringify([job, job, secondJob]))).toEqual([job, secondJob]);
  });
  it.each([null, "broken", "null", "{}"])("handles unavailable or malformed storage: %s", (raw) => {
    expect(readSavedJobs(raw)).toEqual([]);
  });
  it.each([
    { employmentType: {} },
    { salaryCurrency: "invalid" },
    { salaryMinAnnual: "100000" },
    { workMode: "unknown" },
    { sortAt: null },
    { id: -1 },
    { url: "javascript:alert(1)" },
    { applyUrl: "data:text/html,example" },
  ])("discards corrupt entries without losing valid jobs: %j", (change) => {
    expect(readSavedJobs(JSON.stringify([{ ...job, ...change }, job]))).toEqual([job]);
  });
  it("rejects incomplete stored records", () => {
    expect(
      readSavedJobs(JSON.stringify([{ id: 1, title: "Engineer", company: "Company" }])),
    ).toEqual([]);
  });
});
