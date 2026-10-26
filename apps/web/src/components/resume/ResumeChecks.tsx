import type { Resume } from "@tallo/contracts";
import { type Check, checkResume, isEmptyResume } from "@tallo/resume";
import { AlertCircle, Check as CheckIcon, ChevronDown, Lightbulb } from "lucide-react";
import { useMemo, useState } from "react";
import { tidy } from "@/lib/resume/edit";
import { cn } from "@/lib/utils";

/**
 * Instant, deterministic advice on the resume: what is missing or wrong (fixes) and what could read better
 * (tips). Collapsed when there is nothing to fix; a complete resume says so.
 */
export function ResumeChecks({ resume }: { resume: Resume }) {
  const checks = useMemo(() => checkResume(tidy(resume)), [resume]);
  const fixes = checks.filter((check) => check.level === "fix").length;
  const tips = checks.length - fixes;
  const [open, setOpen] = useState(fixes > 0);

  if (isEmptyResume(resume)) return null;

  if (checks.length === 0) {
    return (
      <section
        aria-label="Resume checks"
        className="flex items-center gap-2 rounded-xl border bg-card px-3.5 py-3 text-sm font-medium text-emerald-700 dark:text-emerald-400"
      >
        <CheckIcon className="size-4" aria-hidden />
        Looks complete
      </section>
    );
  }

  return (
    <section
      aria-label="Resume checks"
      className="grid gap-2 rounded-xl border bg-card p-3.5 text-sm"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Checks</span>
          {fixes > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              {fixes} to fix
            </span>
          )}
          {tips > 0 && (
            <span className="text-xs text-muted-foreground">
              {tips} {tips === 1 ? "tip" : "tips"}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open && (
        <ul className="grid gap-2.5">
          {checks.map((check, index) => (
            <CheckItem key={`${index}-${check.message}`} check={check} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CheckItem({ check }: { check: Check }) {
  const fix = check.level === "fix";
  const Icon = fix ? AlertCircle : Lightbulb;
  return (
    <li className="flex items-start gap-2">
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          fix ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
        )}
        aria-hidden
      />
      <span className="grid gap-0.5">
        <span className="leading-snug">{check.message}</span>
        <span className="text-xs capitalize text-muted-foreground">{check.section}</span>
      </span>
    </li>
  );
}
