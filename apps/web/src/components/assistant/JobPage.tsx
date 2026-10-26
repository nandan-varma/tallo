import { ArrowLeft, ArrowUpRight, FileText, Quote, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/assistant/JobRow";
import { useJob, useResumeCopies, useTracker } from "@/components/assistant/queries";
import { StatusMenu } from "@/components/assistant/StatusMenu";
import { JobFacts } from "@/components/JobFacts";
import { JobMeta } from "@/components/JobMeta";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Variants } from "@/components/Variants";
import type { Note } from "@/lib/assistant";
import { afterApplyClick } from "@/lib/tracker";

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

/** The person's own note on a tracked role, saved when the box loses focus. */
function YourNote({ saved, onSave }: { saved: string; onSave: (text: string) => void }) {
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  return (
    <section aria-label="Your note" className="grid gap-1.5">
      <label
        htmlFor="your-note"
        className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
      >
        Your note
      </label>
      <Textarea
        id="your-note"
        value={text}
        maxLength={2000}
        placeholder="Who you spoke to, what to ask, when to follow up…"
        className="min-h-16 text-sm"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => text !== saved && onSave(text)}
      />
    </section>
  );
}

/** One posting, exactly as stored: the description is never cut. */
export function JobPage({ id, note, onClose }: { id: string; note?: Note; onClose: () => void }) {
  const query = useJob(id);
  const job = query.data;
  const link = job?.applyUrl ?? job?.url ?? null;
  const copies = useResumeCopies();
  const tracker = useTracker();
  const tracked = tracker.of(Number(id));
  const hasCopy = copies.data?.some((copy) => copy.jobId === Number(id)) ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="-ml-1.5 gap-1.5"
        >
          <ArrowLeft aria-hidden />
          Back
        </Button>
        <span className="flex-1" />
        {job && (
          <>
            <StatusMenu
              status={tracked?.status}
              onSet={(status) => tracker.set(job, status)}
              onRemove={() => tracker.remove(job.id)}
            />
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <a href={hasCopy ? `/resume/${job.id}` : `/resume/${job.id}?tailor=1`}>
                <FileText aria-hidden />
                <span className="max-sm:sr-only">{hasCopy ? "Your resume" : "Tailor resume"}</span>
              </a>
            </Button>
            {link && (
              <Button asChild size="sm" className="ml-1 gap-1">
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    const next = afterApplyClick(tracked?.status);
                    if (next) tracker.set(job, next);
                  }}
                >
                  Apply
                  <ArrowUpRight aria-hidden />
                </a>
              </Button>
            )}
          </>
        )}
      </header>

      <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <article className="mx-auto w-full max-w-[96rem] px-4 py-7 sm:px-8 @4xl:px-12">
          {query.isPending && <Skeleton />}
          {query.isError && (
            <div className="py-20 text-center">
              <p className="text-sm font-medium">Couldn't load this posting.</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 gap-1.5"
                onClick={() => query.refetch()}
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
              {tracked && (
                <YourNote
                  key={tracked.jobId}
                  saved={tracked.note}
                  onSave={(text) => tracker.set(job, tracked.status, text)}
                />
              )}
              {note && <AssistantNote note={note} />}
              <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-8 @3xl:grid-cols-[minmax(0,1fr)_20rem] @6xl:grid-cols-[minmax(0,1fr)_24rem] @6xl:gap-12">
                <div className="max-w-[110ch] text-[15px] leading-[1.8] whitespace-pre-wrap text-foreground/80 [overflow-wrap:anywhere]">
                  {job.description ?? "The full description is on the company's website."}
                </div>
                <aside className="grid content-start gap-4 @3xl:sticky @3xl:top-4">
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
