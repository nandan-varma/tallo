import type { ApplicationStatus } from "@tallo/contracts";
import type { JobHit } from "@tallo/search-ai";
import { Banknote, Clock3, MapPin, Quote } from "lucide-react";
import { type Note, postedLabel } from "@/lib/assistant";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/tracker";
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

/**
 * One job from the database. If the assistant left a note on it, the note sits underneath, set apart so it is
 * clearly commentary and not part of the posting.
 */
export function JobRow({
  hit,
  note,
  status,
  active,
  onOpen,
}: {
  hit: JobHit;
  note?: Note;
  status?: ApplicationStatus;
  active: boolean;
  onOpen: (id: string) => void;
}) {
  const posted = postedLabel(hit.postedAt);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(hit.id)}
        aria-current={active ? "true" : undefined}
        className={cn(
          "block w-full rounded-xl border bg-card p-3.5 text-left shadow-xs transition-all hover:border-foreground/30 hover:shadow-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.995]",
          active && "border-foreground/50 bg-muted/40 shadow-sm",
        )}
      >
        <span className="flex items-start gap-3">
          <Avatar name={hit.company} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2">
              <span className="text-sm leading-snug font-semibold tracking-tight">{hit.title}</span>
              {status && (
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] font-medium",
                    STATUS_TONE[status],
                  )}
                >
                  {STATUS_LABEL[status]}
                </span>
              )}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
              <span className="font-medium text-foreground/80">{hit.company}</span>
              {hit.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3 shrink-0" aria-hidden />
                  <span className="[overflow-wrap:anywhere]">{hit.location}</span>
                </span>
              )}
              {hit.workMode && <span className="capitalize">{hit.workMode}</span>}
              {hit.pay && (
                <span className="inline-flex items-center gap-1">
                  <Banknote className="size-3 shrink-0" aria-hidden />
                  {hit.pay}
                </span>
              )}
              {posted && (
                <span className="inline-flex items-center gap-1">
                  <Clock3 className="size-3 shrink-0" aria-hidden />
                  {posted}
                </span>
              )}
            </span>
          </span>
        </span>
        {note && (
          <span className="mt-3 block rounded-lg bg-muted/60 px-3 py-2 text-[13px] leading-relaxed">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Assistant
            </span>
            <span className="mt-0.5 block">{note.why}</span>
            {note.evidence.map((quote) => (
              <span key={quote} className="mt-1.5 flex gap-2 text-muted-foreground italic">
                <Quote className="mt-1 size-3 shrink-0 opacity-50" aria-hidden />
                <span className="line-clamp-2">{quote}</span>
              </span>
            ))}
          </span>
        )}
      </button>
    </li>
  );
}
