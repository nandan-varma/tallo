import type { JobSummary } from "@tallo/contracts";
import { JobMeta } from "@/components/JobMeta";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function JobCard({ job }: { job: JobSummary }) {
  return (
    <Card className="transition-colors hover:bg-accent/40">
      <CardHeader>
        <CardTitle className="text-base">
          <a href={`/jobs/${job.id}`} className="hover:underline">
            {job.title}
          </a>
        </CardTitle>
        <JobMeta job={job} />
      </CardHeader>
      <CardContent>
        <p className="line-clamp-2 text-sm text-muted-foreground">{job.excerpt}</p>
      </CardContent>
    </Card>
  );
}
