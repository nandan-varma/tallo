import type { JobSummary } from "@tallo/contracts";
import { JobMeta } from "@/components/JobMeta";
import { Card, CardContent } from "@/components/ui/card";

export function JobCard({ job }: { job: JobSummary }) {
  return (
    <Card className="relative rounded-xl ring-foreground/10 transition-[shadow,ring-color] duration-150 hover:shadow-md hover:ring-foreground/20">
      <CardContent className="grid gap-2">
        {/* Stretched link: the whole card is clickable for touch users. */}
        <a
          href={`/jobs/${job.id}`}
          className="font-heading text-base font-medium leading-snug after:absolute after:inset-0 hover:underline"
        >
          {job.title}
        </a>
        <JobMeta job={job} />
        <p className="line-clamp-2 pr-2 text-sm leading-relaxed text-muted-foreground">
          {job.excerpt}
        </p>
      </CardContent>
    </Card>
  );
}
