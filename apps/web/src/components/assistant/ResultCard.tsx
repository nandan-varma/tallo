import { Banknote, Clock3, MapPin, Quote } from "lucide-react";
import { motion } from "motion/react";
import { payLabel, postedLabel, type RankedMatch } from "@/lib/assistant";
import { cn } from "@/lib/utils";

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-sm font-semibold text-muted-foreground",
        className,
      )}
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function Verdict({ verdict, fit }: { verdict?: "strong" | "maybe"; fit?: number | null }) {
  if (!verdict) return null;
  const strong = verdict === "strong";
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium",
        strong
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-amber-200 bg-amber-50 text-amber-700",
      )}
    >
      {strong ? "Strong fit" : "Possible fit"}
      {typeof fit === "number" && <span className="opacity-70">· {fit}</span>}
    </span>
  );
}

/** One ranked match: why it fits, what the posting actually says, and what it leaves out. */
export function ResultCard({
  match,
  saved,
  active,
  onOpen,
}: {
  match: RankedMatch;
  saved: boolean;
  active: boolean;
  onOpen: (id: string) => void;
}) {
  const { hit } = match;
  const pay = payLabel(hit?.pay ?? null);
  const posted = postedLabel(hit?.postedAt ?? null);
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
    >
      <button
        type="button"
        onClick={() => onOpen(match.id)}
        className={cn(
          "group block w-full rounded-xl border bg-card p-4 text-left shadow-xs transition-all hover:border-foreground/30 hover:shadow-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.995]",
          active && "border-foreground/40",
        )}
      >
        <div className="flex items-start gap-3">
          <Avatar name={hit?.company ?? "?"} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="text-[15px] leading-snug font-semibold tracking-tight">
                {hit?.title ?? `Job ${match.id}`}
              </h3>
              <Verdict verdict={match.verdict} fit={match.fit} />
              {saved && (
                <span className="text-[11px] font-medium text-muted-foreground">Saved</span>
              )}
            </div>
            {hit && (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
                <span className="font-medium text-foreground/80">{hit.company}</span>
                {hit.location && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="size-3" aria-hidden />
                    {hit.location}
                  </span>
                )}
                {hit.workMode && <span className="capitalize">{hit.workMode}</span>}
                {pay && (
                  <span className="inline-flex items-center gap-1">
                    <Banknote className="size-3" aria-hidden />
                    {pay}
                  </span>
                )}
                {posted && (
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="size-3" aria-hidden />
                    {posted}
                  </span>
                )}
              </p>
            )}
            {match.reason && <p className="mt-2.5 text-sm leading-relaxed">{match.reason}</p>}
            {match.evidence.slice(0, 2).map((quote) => (
              <blockquote
                key={quote}
                className="mt-2 flex gap-2 border-l-2 pl-2.5 text-[13px] leading-relaxed text-muted-foreground italic"
              >
                <Quote className="mt-1 size-3 shrink-0 opacity-50" aria-hidden />
                <span className="line-clamp-2">{quote}</span>
              </blockquote>
            ))}
            {match.unknowns.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                <span className="font-medium">Not stated:</span> {match.unknowns.join(" · ")}
              </p>
            )}
          </div>
        </div>
      </button>
    </motion.li>
  );
}
