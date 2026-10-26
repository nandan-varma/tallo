import type { JobAgentMessage, JobHit } from "@tallo/search-ai";
import { FileUser, RotateCcw } from "lucide-react";
import { type RefObject, useMemo } from "react";
import { AboutSheet } from "@/components/assistant/AboutSheet";
import { Composer } from "@/components/assistant/Composer";
import { useStickToBottom } from "@/components/assistant/hooks";
import { Messages } from "@/components/assistant/Messages";
import { Orb } from "@/components/assistant/Orb";
import { lastUserText } from "@/lib/assistant";

const WITH_RESUME = [
  "Best matches for my resume",
  "Remote roles that fit me and pay well",
  "Roles one step up from my current level",
];
const WITHOUT_RESUME = [
  "Senior backend roles, remote in the US",
  "Staff engineers at AI companies",
  "Entry-level data roles in Boston",
];

function EmptyState({ hasResume, onPick }: { hasResume: boolean; onPick: (text: string) => void }) {
  return (
    <div className="flex min-h-full flex-col justify-center px-5 py-10">
      <h1 className="text-xl font-semibold tracking-tight">What are you looking for?</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Describe the role in your own words. I search the whole catalog, read the postings that
        matter, and rank them by fit.
      </p>
      <div className="mt-5 grid gap-2">
        {(hasResume ? WITH_RESUME : WITHOUT_RESUME).map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            className="rounded-xl border bg-card px-3.5 py-2.5 text-left text-sm shadow-xs transition-all hover:border-foreground/30 hover:shadow-sm active:scale-[0.99]"
          >
            {suggestion}
          </button>
        ))}
      </div>
      {!hasResume && (
        <a
          href="/resume"
          className="mt-5 flex items-start gap-2.5 rounded-xl bg-muted/60 px-3.5 py-3 text-[13px] text-muted-foreground transition-colors hover:bg-muted"
        >
          <FileUser className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-foreground">Add your resume</span> and I’ll rank
            matches against your experience.
          </span>
        </a>
      )}
    </div>
  );
}

export function ChatPanel({
  messages,
  hits,
  status,
  error,
  hasResume,
  inputRef,
  onSend,
  onStop,
  onRetry,
  onReset,
  onShowResults,
}: {
  messages: JobAgentMessage[];
  hits: Map<string, JobHit>;
  status: "submitted" | "streaming" | "ready" | "error";
  error: Error | undefined;
  hasResume: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSend: (text: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onReset: () => void;
  onShowResults?: () => void;
}) {
  const busy = status === "submitted" || status === "streaming";
  const { ref, onScroll } = useStickToBottom<HTMLDivElement>(messages);
  const last = useMemo(() => lastUserText(messages), [messages]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
        <Orb className="size-7" busy={busy} />
        <span className="flex-1 truncate text-sm font-medium">{last ? last : "Assistant"}</span>
        <AboutSheet hasResume={hasResume} />
        {messages.length > 0 && (
          <button
            type="button"
            onClick={onReset}
            aria-label="New chat"
            title="New chat"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RotateCcw className="size-4" />
          </button>
        )}
      </header>
      <div
        ref={ref}
        onScroll={onScroll}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        {messages.length === 0 ? (
          <EmptyState hasResume={hasResume} onPick={onSend} />
        ) : (
          <Messages
            messages={messages}
            hits={hits}
            busy={busy}
            waiting={status === "submitted"}
            error={error}
            onRetry={onRetry}
            onShowResults={onShowResults}
          />
        )}
      </div>
      <Composer
        busy={busy}
        onSend={onSend}
        onStop={onStop}
        inputRef={inputRef}
        placeholder={
          messages.length === 0 ? "Describe your ideal role…" : "Refine, or ask for something else…"
        }
      />
    </div>
  );
}
