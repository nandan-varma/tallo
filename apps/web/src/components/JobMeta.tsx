import type { JobSummary } from "@tallo/contracts";
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

/** The facts row shared by result cards and the detail page. Unknown facts are simply absent. */
export function JobMeta({ job, extended = false }: { job: Meta; extended?: boolean }) {
  const pay = salary(job);
  const age = ago(job.postedAt ?? job.sortAt);
  const years = experience(job.expMinYears);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{job.company}</span>
      {job.locationText && <span>{job.locationText}</span>}
      {age && <span>{age}</span>}
      {job.workMode && <Badge variant="secondary">{job.workMode}</Badge>}
      {pay && <Badge variant="outline">{pay}</Badge>}
      {years && <Badge variant="outline">{years}</Badge>}
      {extended && job.department && <Badge variant="outline">{job.department}</Badge>}
      {extended && job.employmentType && <Badge variant="outline">{job.employmentType}</Badge>}
    </div>
  );
}
