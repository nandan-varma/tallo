import type { JobDetail, JobSummary } from "@tallo/contracts";
import { ArrowUpRight, Bookmark, MapPin } from "lucide-react";
import { JobFacts } from "@/components/JobFacts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ago, experience, salary } from "@/lib/format";

export function RoleDetail({
  job,
  detail,
  loading,
  error,
  saved,
  onSave,
  onRetry,
}: {
  job: JobSummary;
  detail: JobDetail | null;
  loading: boolean;
  error: boolean;
  saved: boolean;
  onSave: () => void;
  onRetry: () => void;
}) {
  const current = detail?.id === job.id ? detail : null;
  const link = (current ?? job).applyUrl ?? (current ?? job).url;
  return (
    <article className="role-detail">
      <header className="grid gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{job.company}</p>
            {job.department && (
              <p className="mt-1 text-xs text-muted-foreground">{job.department}</p>
            )}
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onSave}
            aria-label={saved ? "Remove saved job" : "Save job"}
            aria-pressed={saved}
          >
            <Bookmark fill={saved ? "currentColor" : "none"} />
          </Button>
        </div>
        <h2 className="text-2xl leading-tight font-semibold tracking-tight">{job.title}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="size-3.5" />
            {job.locationText ?? "Location not listed"}
          </span>
          <span>{ago(job.postedAt ?? job.sortAt)}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {job.workMode && (
            <Badge variant="secondary" className="capitalize">
              {job.workMode === "onsite" ? "On-site" : job.workMode}
            </Badge>
          )}
          {job.employmentType && (
            <Badge variant="outline">{job.employmentType.replaceAll("_", " ")}</Badge>
          )}
          {experience(job.expMinYears) && (
            <Badge variant="outline">{experience(job.expMinYears)}</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-muted/60 px-3 py-3">
          <div>
            <p className="text-xs text-muted-foreground">Annual compensation</p>
            <p className="mt-1 text-sm font-medium">{salary(job) ?? "Not listed"}</p>
          </div>
          {link ? (
            <Button asChild>
              <a href={link} target="_blank" rel="noopener noreferrer">
                Apply
                <ArrowUpRight />
              </a>
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Application unavailable</span>
          )}
        </div>
      </header>
      <Separator className="my-5" />
      <h3 className="mb-3 text-sm font-semibold">Description</h3>
      {loading ? (
        <div role="status" className="grid gap-3">
          <span className="sr-only">Loading job description</span>
          {[100, 96, 85, 100, 65].map((width, i) => (
            <Skeleton key={i} className="h-3" style={{ width: `${width}%` }} />
          ))}
        </div>
      ) : error ? (
        <div className="grid gap-3 rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">Couldn’t load this job’s description.</p>
          <Button type="button" variant="outline" onClick={onRetry} className="justify-self-start">
            Try again
          </Button>
          {job.excerpt && (
            <p className="text-sm leading-relaxed text-muted-foreground">{job.excerpt}</p>
          )}
        </div>
      ) : (
        <>
          <div className="description-copy">
            {(
              current?.description ??
              "Description unavailable. See the company’s website for details."
            )
              .split(/\n\s*\n/)
              .filter(Boolean)
              .map((paragraph, i) => (
                <p key={i}>{paragraph}</p>
              ))}
          </div>
          {current && (
            <div className="mt-5">
              <JobFacts facts={current.facts} />
            </div>
          )}
        </>
      )}
    </article>
  );
}
