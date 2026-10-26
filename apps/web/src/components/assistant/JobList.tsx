import type { JobSummary, SearchSpec } from "@tallo/contracts";
import { Bookmark, ChevronLeft, ChevronRight, RotateCw, SearchX } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Avatar, JobRow } from "@/components/assistant/JobRow";
import { PAGE_SIZE, useSearchPage } from "@/components/assistant/queries";
import { Button } from "@/components/ui/button";
import type { Note } from "@/lib/assistant";
import { cn } from "@/lib/utils";

export type ListView = "results" | "saved";

function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-20 text-center">
      <SearchX className="mb-3 size-8 text-muted-foreground/50" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {children && (
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{children}</p>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-2.5" aria-label="Loading results">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="flex animate-pulse gap-3 rounded-xl border bg-card p-3.5">
          <div className="size-9 rounded-lg bg-muted" />
          <div className="grid flex-1 gap-2">
            <div className="h-4 w-2/3 rounded bg-muted" />
            <div className="h-3 w-1/2 rounded bg-muted" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function SavedRows({
  saved,
  openId,
  onOpen,
}: {
  saved: JobSummary[];
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  if (saved.length === 0) {
    return (
      <Empty title="Nothing saved yet">Open a role and tap the bookmark to keep it here.</Empty>
    );
  }
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-2.5">
      {[...saved].reverse().map((job) => {
        const id = String(job.id);
        return (
          <li key={id}>
            <button
              type="button"
              onClick={() => onOpen(id)}
              aria-current={id === openId ? "true" : undefined}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border bg-card p-3.5 text-left shadow-xs transition-all hover:border-foreground/30 hover:shadow-sm",
                id === openId && "border-foreground/50 bg-muted/40",
              )}
            >
              <Avatar name={job.company} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{job.title}</span>
                <span className="block truncate text-[13px] text-muted-foreground">
                  {job.company}
                  {job.locationText ? ` · ${job.locationText}` : ""}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The results list: the database's answer to the assistant's search, 20 to a page. The assistant chose the
 * search and may have left notes; it never writes the list. Wide beside the chat, narrow beside an open
 * posting, so you can keep browsing while you read.
 */
export function JobList({
  spec,
  notes,
  saved,
  view,
  onView,
  openId,
  working,
  started,
  onOpen,
}: {
  spec: SearchSpec | null;
  notes: Map<string, Note>;
  saved: JobSummary[];
  view: ListView;
  onView: (view: ListView) => void;
  openId: string | null;
  /** The assistant is working, so a new search may be on its way. */
  working: boolean;
  started: boolean;
  onOpen: (id: string) => void;
}) {
  // Pages are reached by cursor: the stack is the cursors of the pages visited, for one search at a time.
  const searchKey = JSON.stringify(spec);
  const [stack, setStack] = useState<{ key: string; cursors: (string | undefined)[] }>({
    key: searchKey,
    cursors: [undefined],
  });
  const cursors = stack.key === searchKey ? stack.cursors : [undefined];
  const page = cursors.length - 1;
  const query = useSearchPage(spec, cursors[page]);
  const scroller = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different search or page starts at the top
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [searchKey, page]);

  const hits = query.data?.hits ?? [];
  const nextCursor = query.data?.nextCursor ?? null;
  const savedIds = new Set(saved.map((job) => String(job.id)));
  const go = (next: (string | undefined)[]) => setStack({ key: searchKey, cursors: next });

  let body: ReactNode;
  if (view === "saved") {
    body = <SavedRows saved={saved} openId={openId} onOpen={onOpen} />;
  } else if (!spec) {
    body = working ? (
      <Skeleton />
    ) : (
      <Empty title={started ? "Results appear here" : "Your results will appear here"}>
        {started
          ? "Once the assistant has searched, every matching role is listed here."
          : "Tell the assistant what you're after. It builds the search; the list is straight from the catalog."}
      </Empty>
    );
  } else if (query.isError && !query.data) {
    body = (
      <div className="py-16 text-center">
        <p className="text-sm font-medium">Couldn't load the results.</p>
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
    );
  } else if (!query.data) {
    body = <Skeleton />;
  } else if (hits.length === 0) {
    body = (
      <Empty title="No roles match this search">
        Ask the assistant to widen the place or try nearby titles.
      </Empty>
    );
  } else {
    body = (
      <ul
        className={cn(
          "grid grid-cols-[minmax(0,1fr)] gap-2.5 transition-opacity",
          (query.isPlaceholderData || working) && "opacity-60",
        )}
        aria-label="Search results"
      >
        {hits.map((hit) => (
          <JobRow
            key={hit.id}
            hit={hit}
            note={notes.get(hit.id)}
            saved={savedIds.has(hit.id)}
            active={hit.id === openId}
            onOpen={onOpen}
          />
        ))}
      </ul>
    );
  }

  const paged = view === "results" && spec !== null && (page > 0 || nextCursor !== null);
  const from = page * PAGE_SIZE + 1;
  const to = page * PAGE_SIZE + hits.length;
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h2 className="truncate text-sm font-medium">
          {view === "saved" ? "Saved roles" : "Results"}
        </h2>
        <div
          role="tablist"
          aria-label="List"
          className="flex rounded-lg bg-muted p-0.5 text-[13px]"
        >
          {(["results", "saved"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={view === tab}
              onClick={() => onView(tab)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors",
                view === tab
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab === "saved" && <Bookmark className="size-3" aria-hidden />}
              {tab === "results" ? "Results" : `Saved${saved.length ? ` ${saved.length}` : ""}`}
            </button>
          ))}
        </div>
      </header>

      <div
        ref={scroller}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-4">{body}</div>
      </div>

      {paged && (
        <nav
          aria-label="Pagination"
          className="flex shrink-0 items-center justify-between gap-3 border-t bg-card px-4 py-2.5"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => go(cursors.slice(0, -1))}
            disabled={page === 0}
            className="gap-1"
          >
            <ChevronLeft aria-hidden />
            Previous
          </Button>
          <span className="text-[13px] text-muted-foreground tabular-nums" aria-live="polite">
            {hits.length > 0 ? `${from}–${to}` : ""}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => nextCursor && go([...cursors, nextCursor])}
            disabled={!nextCursor || query.isPlaceholderData}
            className="gap-1"
          >
            Next
            <ChevronRight aria-hidden />
          </Button>
        </nav>
      )}
    </div>
  );
}
