import type { Fit, ResumeRecord } from "@tallo/contracts";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Quote, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { messageOf, requestJson } from "@/lib/client";
import { tidy } from "@/lib/resume/edit";
import { cn } from "@/lib/utils";

const NO_RESUME = "Add your resume first.";

const VERDICT_LABEL: Record<Fit["verdict"], string> = {
  strong: "Strong fit",
  good: "Good fit",
  stretch: "Stretch",
  weak: "Weak fit",
};

const VERDICT_BAR: Record<Fit["verdict"], string> = {
  strong: "bg-emerald-500",
  good: "bg-sky-500",
  stretch: "bg-amber-500",
  weak: "bg-muted-foreground/50",
};

const VERDICT_TONE: Record<Fit["verdict"], string> = {
  strong: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  good: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  stretch: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  weak: "bg-muted text-muted-foreground",
};

/** Compares the person's base resume with one posting. The server checks every quote against both texts. */
export function useFit(jobId: number) {
  return useMutation({
    mutationFn: async (): Promise<Fit> => {
      const record = await requestJson<ResumeRecord | null>("/api/resume");
      if (!record) throw new Error(NO_RESUME);
      return requestJson<Fit>("/api/resume/fit", {
        method: "POST",
        body: { jobId, resume: tidy(record.doc.resume) },
      });
    },
  });
}

const LABEL = "text-[11px] font-medium tracking-wide text-muted-foreground uppercase";

function FitResult({ fit }: { fit: Fit }) {
  return (
    <div className="mt-2 grid gap-4">
      <div className="grid gap-2.5">
        <div className="flex items-baseline gap-2.5">
          <span className="text-3xl font-semibold tracking-tight tabular-nums">{fit.percent}%</span>
          <Badge className={VERDICT_TONE[fit.verdict]}>{VERDICT_LABEL[fit.verdict]}</Badge>
        </div>
        <div
          role="progressbar"
          aria-label="Fit"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={fit.percent}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn("h-full rounded-full", VERDICT_BAR[fit.verdict])}
            style={{ width: `${fit.percent}%` }}
          />
        </div>
        <p className="text-sm leading-relaxed">{fit.summary}</p>
        <p className="text-xs text-muted-foreground">
          {fit.matches.length} of {fit.matches.length + fit.gaps.length} requirements the posting
          states are shown in your resume.
        </p>
      </div>
      {fit.matches.length > 0 && (
        <div className="grid gap-2">
          <p className={LABEL}>Where you match</p>
          <ul className="grid gap-3">
            {fit.matches.map((match) => (
              <li key={`${match.requirement}|${match.evidence}`} className="grid gap-1">
                <p className="text-sm font-medium">{match.requirement}</p>
                <p className="flex gap-2 border-l-2 pl-2.5 text-[13px] leading-relaxed text-muted-foreground italic">
                  <Quote className="mt-1 size-3 shrink-0 opacity-50" aria-hidden />
                  <span>{match.evidence}</span>
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {fit.gaps.length > 0 && (
        <div className="grid gap-2">
          <p className={LABEL}>Gaps</p>
          <ul className="grid gap-3">
            {fit.gaps.map((gap) => (
              <li key={`${gap.requirement}|${gap.advice}`} className="grid gap-1">
                <p className="text-sm font-medium">{gap.requirement}</p>
                <p className="text-[13px] leading-relaxed text-muted-foreground">{gap.advice}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** How well the person's resume fits this posting. Keyed by job at the call site, so it resets on change. */
export function FitCard({ jobId }: { jobId: number }) {
  const fit = useFit(jobId);
  const needsResume = fit.isError && fit.error.message === NO_RESUME;

  return (
    <section className="rounded-xl border bg-muted/40 p-4" aria-label="Your fit">
      <p className={LABEL}>Your fit</p>

      {fit.isIdle && (
        <div className="mt-2 grid gap-2.5">
          <p className="text-sm text-muted-foreground">
            Compares your resume with this posting. Takes about 10 seconds.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit gap-1.5"
            onClick={() => fit.mutate()}
          >
            <Target aria-hidden />
            Check my fit
          </Button>
        </div>
      )}

      {fit.isPending && (
        <p role="status" className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Reading the posting…
        </p>
      )}

      {fit.isError && (
        <div className="mt-2 grid gap-2.5">
          <p className="text-sm text-destructive">{messageOf(fit.error)}</p>
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
              onClick={() => fit.mutate()}
            >
              Try again
            </Button>
          )}
        </div>
      )}

      {fit.isSuccess && (
        <>
          <FitResult fit={fit.data} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-3 -ml-2.5"
            onClick={() => fit.reset()}
          >
            Check again
          </Button>
        </>
      )}
    </section>
  );
}
