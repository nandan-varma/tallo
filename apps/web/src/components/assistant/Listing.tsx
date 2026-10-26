import type { JobDetail, JobSummary } from "@tallo/contracts";
import { ArrowLeft, ArrowUpRight, Bookmark, ExternalLink, Quote, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { summaryOf } from "@/components/assistant/hooks";
import { Avatar, Verdict } from "@/components/assistant/ResultCard";
import { JobFacts } from "@/components/JobFacts";
import { JobMeta } from "@/components/JobMeta";
import { Button } from "@/components/ui/button";
import { Variants } from "@/components/Variants";
import { markQuotes, type RankedMatch } from "@/lib/assistant";
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
      .catch((error) => {
        if (!controller.signal.aborted) setLoad({ state: "error" });
        if (error?.name === "AbortError") return;
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
        {[100, 95, 90, 98, 70, 100, 92, 60].map((w, i) => (
          <div key={i} className="h-3 rounded bg-muted" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

/** The assistant's read of this job, with its quotes. Each quote scrolls to where the posting says it. */
function WhyItFits({ match, found }: { match: RankedMatch; found: Set<number> }) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-xs" aria-label="Why this fits">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Why it fits</h2>
        <Verdict verdict={match.verdict} fit={match.fit} />
      </div>
      {match.reason && <p className="mt-2 text-sm leading-relaxed">{match.reason}</p>}
      {match.evidence.map((quote, i) => (
        <button
          key={quote}
          type="button"
          disabled={!found.has(i)}
          onClick={() =>
            document
              .getElementById(`evidence-${i}`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" })
          }
          className="mt-2 flex w-full gap-2 border-l-2 pl-2.5 text-left text-[13px] leading-relaxed text-muted-foreground italic enabled:hover:text-foreground"
        >
          <Quote className="mt-1 size-3 shrink-0 opacity-50" aria-hidden />
          <span>{quote}</span>
        </button>
      ))}
      {match.unknowns.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          <span className="font-medium">The posting doesn't say:</span> {match.unknowns.join(" · ")}
        </p>
      )}
    </section>
  );
}

/** The posting text exactly as stored, never cut, with the quotes the assistant cited marked in place. */
function Description({ text, quotes }: { text: string | null; quotes: string[] }) {
  const segments = useMemo(() => (text ? markQuotes(text, quotes) : []), [text, quotes]);
  if (!text) {
    return (
      <p className="text-sm text-muted-foreground">
        The full description is on the company's website.
      </p>
    );
  }
  return (
    <div className="text-[15px] leading-[1.8] whitespace-pre-wrap text-foreground/80 [overflow-wrap:anywhere]">
      {segments.map((segment, i) =>
        segment.quote === undefined ? (
          segment.text
        ) : (
          <mark
            key={i}
            id={`evidence-${segment.quote}`}
            className="rounded-sm bg-amber-100 px-0.5 text-foreground"
          >
            {segment.text}
          </mark>
        ),
      )}
    </div>
  );
}

export function Listing({
  id,
  match,
  saved,
  onToggleSave,
  onBack,
}: {
  id: string;
  match?: RankedMatch;
  saved: boolean;
  onToggleSave: (job: JobSummary) => void;
  onBack: () => void;
}) {
  const { load, retry } = useJob(id);
  const job = load.state === "ready" ? load.job : null;
  const link = job?.applyUrl ?? job?.url ?? null;
  const quotes = match?.evidence ?? [];
  const found = useMemo(() => {
    const set = new Set<number>();
    if (job?.description) {
      markQuotes(job.description, quotes).forEach((s) => {
        if (s.quote !== undefined) set.add(s.quote);
      });
    }
    return set;
  }, [job, quotes]);

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
          Matches
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
            <div className="grid gap-6">
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
              {match && <WhyItFits match={match} found={found} />}
              <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_17rem]">
                <Description text={job.description} quotes={quotes} />
                <aside className="grid content-start gap-4 xl:order-last">
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
