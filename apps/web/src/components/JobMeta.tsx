import type { JobSummary } from "@tallo/contracts";
import { Badge } from "@/components/ui/badge";
import { ago, experience, salary } from "@/lib/format";
import { Clock3, Banknote, Code2 } from "lucide-react";

type Meta = Pick<
  JobSummary,
  | "company"
  | "locationText"
  | "workMode"
  | "department"
  | "employmentType"
  | "salaryMinAnnual"
  | "salaryMaxAnnual"
  | "salaryCurrency"
  | "expMinYears"
  | "postedAt"
  | "sortAt"
>;

/** The facts row shared by result cards and the detail page. Unknown facts are simply absent. */
export function JobMeta({ job, extended = false }: { job: Meta; extended?: boolean }) {
  const pay = salary(job);
  const age = ago(job.postedAt ?? job.sortAt);
  const years = experience(job.expMinYears);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{job.company}</span>
      {job.locationText && (
        <span className="flex items-center gap-1">
          <MapPin />
          {job.locationText}
        </span>
      )}
      {age && (
        <span className="flex items-center gap-1">
          <Clock3 />
          {age}
        </span>
      )}
      {job.workMode && <Badge variant="secondary">{job.workMode}</Badge>}
      {pay && (
        <Badge variant="outline" className="gap-1">
          <Banknote />
          {pay}
        </Badge>
      )}
      {years && (
        <Badge variant="outline" className="gap-1">
          <Code2 />
          {years}
        </Badge>
      )}
      {extended && job.department && <Badge variant="outline">{job.department}</Badge>}
      {extended && job.employmentType && <Badge variant="outline">{job.employmentType}</Badge>}
    </div>
  );
}

function MapPin() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
    >
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}
