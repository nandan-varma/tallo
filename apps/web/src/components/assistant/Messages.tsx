import type { JobAgentMessage, JobHit } from "@tallo/search-ai";
import {
  ArrowRight,
  Check,
  FileText,
  ListOrdered,
  Loader2,
  Search,
  TriangleAlert,
} from "lucide-react";
import { type Activity, activitiesOf, textOf } from "@/lib/assistant";
import { cn } from "@/lib/utils";

const ICON = { search: Search, read: FileText, rank: ListOrdered } as const;

function StateIcon({ item }: { item: Activity }) {
  if (item.state === "running")
    return <Loader2 className="size-3.5 animate-spin" aria-label="In progress" />;
  if (item.state === "error")
    return <TriangleAlert className="size-3.5 text-destructive" aria-label="Failed" />;
  return <Check className="size-3.5 text-emerald-600" aria-label="Done" />;
}

function Timeline({ items }: { items: Activity[] }) {
  return (
    <ol className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      {items.map((item) => {
        const Icon = ICON[item.tool];
        return (
          <li key={item.key} className="flex items-start gap-2 text-[13px] leading-5">
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground">
              <Icon className="size-3.5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  item.state === "running" ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {item.label}
              </span>
              {item.detail && (
                <span
                  className="block truncate text-xs text-muted-foreground/80"
                  title={item.detail}
                >
                  {item.detail}
                </span>
              )}
            </span>
            <span className="mt-0.5 shrink-0">
              <StateIcon item={item} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** One line for a finished turn: "2 searches · read 3 in full · ranked 10 matches". */
function summary(items: Activity[]): string {
  const searches = items.filter((i) => i.tool === "search").length;
  const reads = items.filter((i) => i.tool === "read").length;
  const rank = items.find((i) => i.tool === "rank");
  return [
    searches > 0 && `${searches} ${searches === 1 ? "search" : "searches"}`,
    reads > 0 && `read ${reads} in full`,
    rank && rank.state !== "error" && rank.label.charAt(0).toLowerCase() + rank.label.slice(1),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** While the assistant works the steps are open and live; afterwards they fold into one quiet line. */
function Activities({ items, live }: { items: Activity[]; live: boolean }) {
  if (items.length === 0) return null;
  if (live || items.some((i) => i.state === "running")) {
    return (
      <div className="min-w-0 overflow-hidden rounded-xl border bg-muted/40 px-3 py-2.5">
        <Timeline items={items} />
      </div>
    );
  }
  return (
    <details className="group min-w-0 overflow-hidden rounded-xl border bg-muted/40 text-[13px]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground select-none marker:hidden">
        <Check className="size-3.5 text-emerald-600" aria-hidden />
        <span className="flex-1 truncate">{summary(items)}</span>
        <ArrowRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
      </summary>
      <div className="border-t px-3 py-2.5">
        <Timeline items={items} />
      </div>
    </details>
  );
}

function Typing() {
  return (
    <span
      className="inline-flex items-center gap-1 py-2"
      role="status"
      aria-label="The assistant is thinking"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </span>
  );
}

function AssistantMessage({
  message,
  hits,
  live,
  onShowMatches,
}: {
  message: JobAgentMessage;
  hits: Map<string, JobHit>;
  live: boolean;
  onShowMatches?: () => void;
}) {
  const items = activitiesOf(message, hits);
  const text = textOf(message);
  const ranked = items.find(
    (i) => i.tool === "rank" && i.state === "done" && !i.label.startsWith("Nothing"),
  );
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5">
      <Activities items={items} live={live} />
      {text && (
        <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          {text}
        </p>
      )}
      {live && !text && items.length === 0 && <Typing />}
      {ranked && onShowMatches && (
        <button
          type="button"
          onClick={onShowMatches}
          className="inline-flex w-fit items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-[13px] font-medium shadow-xs transition-colors hover:bg-muted"
        >
          View {ranked.label.replace("Ranked ", "")}
          <ArrowRight className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function Messages({
  messages,
  hits,
  busy,
  waiting,
  error,
  onRetry,
  onShowMatches,
}: {
  messages: JobAgentMessage[];
  hits: Map<string, JobHit>;
  busy: boolean;
  /** Sent, nothing back yet. */
  waiting: boolean;
  error: Error | undefined;
  onRetry: () => void;
  /** Only passed when results are on another screen (mobile). */
  onShowMatches?: () => void;
}) {
  const last = messages.at(-1);
  return (
    <ul
      className="grid grid-cols-[minmax(0,1fr)] gap-5 px-4 py-5"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {messages.map((message) => (
        <li
          key={message.id}
          className={cn("min-w-0", message.role === "user" && "flex justify-end")}
        >
          {message.role === "user" ? (
            <p className="max-w-[88%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap text-primary-foreground">
              {textOf(message)}
            </p>
          ) : (
            <AssistantMessage
              message={message}
              hits={hits}
              live={busy && message === last}
              onShowMatches={onShowMatches}
            />
          )}
        </li>
      ))}
      {waiting && last?.role === "user" && (
        <li>
          <Typing />
        </li>
      )}
      {error && !busy && (
        <li className="rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm">
          <p className="font-medium text-destructive">The assistant hit a problem.</p>
          <p className="mt-0.5 text-muted-foreground">{friendly(error)}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 text-[13px] font-medium underline underline-offset-4 hover:no-underline"
          >
            Try again
          </button>
        </li>
      )}
    </ul>
  );
}

function friendly(error: Error): string {
  if (/503/.test(error.message)) return "The assistant isn't set up on the server yet.";
  if (/401|403/.test(error.message)) return "Your session expired. Reload the page.";
  if (/413/.test(error.message)) return "This conversation is too long. Start a new chat.";
  return "Check your connection and try again.";
}
