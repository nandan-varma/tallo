import type { JobDetail, JobSummary } from "@tallo/contracts";
import { ArrowLeft, ArrowUpRight, Bookmark, ExternalLink, Quote, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { summaryOf } from "@/components/assistant/hooks";
import { Avatar } from "@/components/assistant/JobRow";
import { JobFacts } from "@/components/JobFacts";
import { JobMeta } from "@/components/JobMeta";
import { Button } from "@/components/ui/button";
import { Variants } from "@/components/Variants";
import type { Note } from "@/lib/assistant";
import { cn } from "@/lib/utils";

const cache = new Map<string, JobDetail>();

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; job: JobDetail };

/** One job's detail, kept for the visit so going back and forth never refetches. */
function useJob(id: string) {
  const [load, setLoad] = useState<Load>(() => {
    const hit = cache.get(id);
    return hit ? { state: "ready", job: hit } : { state: "loading" };
  });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the fetch for Retry
  useEffect(() => {
    const cached = cache.get(id);
    if (cached) {
      setLoad({ state: "ready", job: cached });
      return;
    }
    setLoad({ state: "loading" });
    const controller = new AbortController();
    fetch(`/api/jobs/${id}.json`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<JobDetail>;
      })
      .then((job) => {
        cache.set(id, job);
        setLoad({ state: "ready", job });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ state: "error" });
      });
    return () => controller.abort();
  }, [id, attempt]);

  return { load, retry: useCallback(() => setAttempt((n) => n + 1), []) };
}

function Skeleton() {
  return (
    <div className="grid animate-pulse gap-4" role="status" aria-label="Loading the posting">
      <div className="h-4 w-32 rounded bg-muted" />
      <div className="h-8 w-3/4 rounded bg-muted" />
      <div className="h-4 w-1/2 rounded bg-muted" />
      <div className="mt-6 grid gap-2">
        {[100, 95, 90, 98, 70, 100, 92, 60].map((w) => (
          <div key={w} className="h-3 rounded bg-muted" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

/** What the assistant said about this job. Its quotes were checked against the posting on the server. */
function AssistantNote({ note }: { note: Note }) {
  return (
    <section className="rounded-xl border bg-muted/40 p-4" aria-label="Note from the assistant">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Assistant
      </p>
      <p className="mt-1 text-sm leading-relaxed">{note.why}</p>
      {note.evidence.map((quote) => (
        <p
          key={quote}
          className="mt-2 flex gap-2 border-l-2 pl-2.5 text-[13px] leading-relaxed text-muted-foreground italic"
        >
          <Quote className="mt-1 size-3 shrink-0 opacity-50" aria-hidden />
          <span>{quote}</span>
        </p>
      ))}
    </section>
  );
}

/** One posting, exactly as stored: the description is never cut. */
export function Listing({
  id,
  note,
  saved,
  onToggleSave,
  onBack,
}: {
  id: string;
  note?: Note;
  saved: boolean;
  onToggleSave: (job: JobSummary) => void;
  onBack: () => void;
}) {
  const { load, retry } = useJob(id);
  const job = load.state === "ready" ? load.job : null;
  const link = job?.applyUrl ?? job?.url ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="-ml-1.5 gap-1.5"
        >
          <ArrowLeft aria-hidden />
          Chat
        </Button>
        <span className="flex-1" />
        {job && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onToggleSave(summaryOf(job))}
              aria-pressed={saved}
              aria-label={saved ? "Remove from saved" : "Save this role"}
            >
              <Bookmark className={cn(saved && "fill-current")} />
            </Button>
            <Button asChild variant="ghost" size="icon" aria-label="Open the standalone page">
              <a href={`/jobs/${job.id}`} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
              </a>
            </Button>
            {link && (
              <Button asChild size="sm" className="ml-1 gap-1">
                <a href={link} target="_blank" rel="noopener noreferrer">
                  Apply
                  <ArrowUpRight aria-hidden />
                </a>
              </Button>
            )}
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <article className="mx-auto w-full max-w-3xl px-4 py-7 sm:px-8">
          {load.state === "loading" && <Skeleton />}
          {load.state === "error" && (
            <div className="py-20 text-center">
              <p className="text-sm font-medium">Couldn't load this posting.</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 gap-1.5"
                onClick={retry}
              >
                <RotateCw aria-hidden />
                Try again
              </Button>
            </div>
          )}
          {job && (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
              <header className="grid gap-3">
                <div className="flex items-center gap-2.5">
                  <Avatar name={job.company} />
                  <p className="text-sm font-medium">{job.company}</p>
                </div>
                <h1 className="text-2xl leading-tight font-semibold tracking-tight sm:text-3xl">
                  {job.title}
                </h1>
                <JobMeta job={job} extended />
              </header>
              {note && <AssistantNote note={note} />}
              <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_17rem]">
                <div className="text-[15px] leading-[1.8] whitespace-pre-wrap text-foreground/80 [overflow-wrap:anywhere]">
                  {job.description ?? "The full description is on the company's website."}
                </div>
                <aside className="grid content-start gap-4">
                  <Variants variants={job.variants} currentId={job.id} />
                  <JobFacts facts={job.facts} />
                </aside>
              </div>
            </div>
          )}
        </article>
      </div>
    </div>
  );
}
