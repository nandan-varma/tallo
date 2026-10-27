import type { Prep, ResumeRecord } from "@tallo/contracts";
import { useMutation } from "@tanstack/react-query";
import { Loader2, MessagesSquare, Quote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { messageOf, requestJson } from "@/lib/client";
import { tidy } from "@/lib/resume/edit";

const NO_RESUME = "Add your resume first.";

/** Likely interview questions for this posting. The server checks every quote against the resume. */
export function usePrep(jobId: number) {
  return useMutation({
    mutationFn: async (): Promise<Prep> => {
      const record = await requestJson<ResumeRecord | null>("/api/resume");
      if (!record) throw new Error(NO_RESUME);
      return requestJson<Prep>("/api/resume/prep", {
        method: "POST",
        body: { jobId, resume: tidy(record.doc.resume) },
      });
    },
  });
}

const LABEL = "text-[11px] font-medium tracking-wide text-muted-foreground uppercase";

function PrepResult({ prep }: { prep: Prep }) {
  return (
    <div className="mt-2 grid gap-4">
      {prep.questions.length > 0 && (
        <ol className="grid gap-4">
          {prep.questions.map((item) => (
            <li key={`${item.question}|${item.angle}`} className="grid gap-1.5">
              <p className="text-sm font-medium">{item.question}</p>
              <p className="text-[13px] leading-relaxed text-muted-foreground">{item.angle}</p>
              {item.evidence && (
                <p className="flex gap-2 border-l-2 pl-2.5 text-[13px] leading-relaxed text-muted-foreground italic">
                  <Quote className="mt-1 size-3 shrink-0 opacity-50" aria-hidden />
                  <span>{item.evidence}</span>
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {prep.ask.length > 0 && (
        <div className="grid gap-2">
          <p className={LABEL}>Questions to ask them</p>
          <ul className="grid list-disc gap-2 pl-5">
            {prep.ask.map((question) => (
              <li key={question} className="text-sm leading-relaxed">
                {question}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Interview prep for this posting. Keyed by job at the call site, so it resets on change. */
export function PrepCard({ jobId }: { jobId: number }) {
  const prep = usePrep(jobId);
  const needsResume = prep.isError && prep.error.message === NO_RESUME;

  return (
    <section className="rounded-xl border bg-muted/40 p-4" aria-label="Interview prep">
      <p className={LABEL}>Interview prep</p>

      {prep.isIdle && (
        <div className="mt-2 grid gap-2.5">
          <p className="text-sm text-muted-foreground">
            Likely questions, with answers drawn from your resume. Takes about 10 seconds.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit gap-1.5"
            onClick={() => prep.mutate()}
          >
            <MessagesSquare aria-hidden />
            Prepare me
          </Button>
        </div>
      )}

      {prep.isPending && (
        <p role="status" className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Preparing your answers…
        </p>
      )}

      {prep.isError && (
        <div className="mt-2 grid gap-2.5">
          <p className="text-sm text-destructive">{messageOf(prep.error)}</p>
          {needsResume ? (
            <a href="/resume" className="w-fit text-sm underline underline-offset-2">
              Open your resume
            </a>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => prep.mutate()}
            >
              Try again
            </Button>
          )}
        </div>
      )}

      {prep.isSuccess && (
        <>
          <PrepResult prep={prep.data} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-3 -ml-2.5"
            onClick={() => prep.reset()}
          >
            Prepare again
          </Button>
        </>
      )}
    </section>
  );
}
