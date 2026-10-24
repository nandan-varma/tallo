import type { JobSummary } from "@tallo/contracts";
import { Banknote, Clock3, Code2, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ago, experience, salary } from "@/lib/format";

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

/**
 * The secondary fact row shared by result cards and the detail page. One
 * leading text block then badges, all at text-xs, so cards and headers align.
 */
export function JobMeta({ job, extended = false }: { job: Meta; extended?: boolean }) {
  const age = ago(job.postedAt ?? job.sortAt);
  const years = experience(job.expMinYears);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {job.locationText && (
        <span className="flex min-w-0 items-center gap-1">
          <MapPin strokeWidth={2} className="size-3 shrink-0" />
          <span className="truncate">{job.locationText}</span>
        </span>
      )}
      {age && (
        <span className="flex items-center gap-1">
          <Clock3 strokeWidth={2} className="size-3 shrink-0" />
          {age}
        </span>
      )}
      {years && (
        <span className="flex items-center gap-1">
          <Code2 strokeWidth={2} className="size-3 shrink-0" />
          {years}
        </span>
      )}
      {job.workMode && <Badge variant="secondary">{job.workMode}</Badge>}
      {extended && (
        <>
          <span className="flex items-center gap-1">
            <Banknote strokeWidth={2} className="size-3 shrink-0" />
            {salaryText(job)}
          </span>
          {job.department && <Badge variant="outline">{job.department}</Badge>}
          {job.employmentType && <Badge variant="outline">{job.employmentType}</Badge>}
        </>
      )}
    </div>
  );
}

const salaryText = (job: Meta) => salary(job);
