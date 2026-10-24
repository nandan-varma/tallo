import type { JobSummary } from "@tallo/contracts";
import { Clock3, Code2, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ago, experience, salary } from "@/lib/format";

/**
 * One row of the results list. A real list-alignment of title/company/facts
 * line up down the page, so it scans like a table — no card chrome. The
 * overlay link covers the whole row; the excerpt volunteers as plain text.
 */
export function JobCard({ job }: { job: JobSummary }) {
  const pay = salary(job);
  const age = ago(job.postedAt ?? job.sortAt);
  const years = experience(job.expMinYears);
  return (
    <li className="group relative border-b border-border/70 px-3 py-3 first:rounded-t-lg last:rounded-b-lg hover:bg-accent/50">
      <a href={`/jobs/${job.id}`} className="absolute inset-0 z-10">
        <span className="sr-only">{`View ${job.title} at ${job.company}`}</span>
      </a>
      <div className="pointer-events-none grid gap-1 relative">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="min-w-0 truncate font-heading text-sm font-medium text-foreground group-hover:underline">
            {job.title}
          </h3>
          {pay && (
            <span className="shrink-0 font-heading text-sm font-medium tabular-nums text-foreground">
              {pay}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          <span className="shrink-0 font-medium text-foreground/90">{job.company}</span>
          {job.locationText && (
            <span className="pointer-events-none flex min-w-0 items-center gap-1">
              <MapPin strokeWidth={2} className="size-3 shrink-0" />
              <span className="max-w-48 truncate">{job.locationText}</span>
            </span>
          )}
          {age && (
            <span className="shrink-0 flex items-center gap-1">
              <Clock3 strokeWidth={2} className="size-3 shrink-0" />
              {age}
            </span>
          )}
          {years && (
            <span className="shrink-0 flex items-center gap-1">
              <Code2 strokeWidth={2} className="size-3 shrink-0" />
              {years}
            </span>
          )}
          {job.workMode && <Badge className="pointer-events-none">{job.workMode}</Badge>}
          <span className="ml-auto hidden min-w-0 truncate sm:inline">{job.excerpt}</span>
        </div>
      </div>
    </li>
  );
}
