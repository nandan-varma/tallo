import type { JobSummary } from "@tallo/contracts";
import { JobMeta } from "@/components/JobMeta";
import { Card } from "@/components/ui/card";
import { salary } from "@/lib/format";

/**
 * Result card in the fluid grid. Fixed line order (title → company → meta →
 * excerpt → pay footer) keeps every card's rows aligned across the grid so
 * cards on the same row line up; pay sits on the footer line as the key fact.
 */
export function JobCard({ job }: { job: JobSummary }) {
  const pay = salary(job);
  return (
    <Card className="relative grid content-start gap-2 rounded-lg p-4 ring-foreground/10 transition-colors hover:ring-foreground/25">
      <a
        href={`/jobs/${job.id}`}
        className="font-heading text-[0.95rem] font-medium leading-snug text-foreground after:absolute after:inset-0 hover:underline"
      >
        {job.title}
      </a>
      <div className="text-xs font-medium text-foreground/90">{job.company}</div>
      <JobMeta job={job} />
      <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{job.excerpt}</p>
      {pay && (
        <div className="mt-auto border-t border-border pt-2 font-heading text-sm font-medium tabular-nums text-foreground">
          {pay}
        </div>
      )}
    </Card>
  );
}
