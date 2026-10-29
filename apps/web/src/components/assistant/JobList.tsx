import { APPLICATION_STATUSES, type ApplicationStatus, type SearchSpec } from "@tallo/contracts";
import type { JobHit } from "@tallo/search-ai";
import { Bookmark, ChevronLeft, ChevronRight, RotateCw, SearchX } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Avatar, JobRow } from "@/components/assistant/JobRow";
import { PAGE_SIZE, useSearchPage, useTracker } from "@/components/assistant/queries";
import { StatusMenu } from "@/components/assistant/StatusMenu";
import { Button } from "@/components/ui/button";
import type { Note } from "@/lib/assistant";
import { ago } from "@/lib/format";
import {
  countByStatus,
  filterByStatus,
  needsFollowUp,
  STATUS_LABEL,
  type StatusFilter,
} from "@/lib/tracker";
import { cn } from "@/lib/utils";

export type ListView = "results" | "tracker";

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

/** Every role the person saved or applied to, filtered by status, with the status one tap away. */
function TrackerRows({ openId, onOpen }: { openId: string | null; onOpen: (id: string) => void }) {
  const tracker = useTracker();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const counts = countByStatus(tracker.applications);
  const shown = filterByStatus(tracker.applications, filter);

  if (tracker.loading) return <Skeleton />;
  if (tracker.applications.length === 0) {
    return (
      <Empty title="Nothing tracked yet">
        Save a role, or apply to one, and it is kept here with its status and your notes.
      </Empty>
    );
  }
  return (
    <div className="grid gap-3">
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
        <legend className="sr-only">Filter by status</legend>
        {(["all", ...APPLICATION_STATUSES] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            onClick={() => setFilter(option)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              filter === option
                ? "border-foreground bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {option === "all" ? "All" : STATUS_LABEL[option]} {counts[option]}
          </button>
        ))}
      </fieldset>
      {shown.length === 0 ? (
        <Empty title={`Nothing ${STATUS_LABEL[filter as ApplicationStatus].toLowerCase()}`} />
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-2.5" aria-label="Tracked roles">
          {shown.map((application) => {
            const id = String(application.jobId);
            return (
              <li
                key={id}
                className={cn(
                  "flex items-center gap-2 rounded-xl border bg-card pr-2 shadow-xs transition-all hover:border-foreground/30 hover:shadow-sm",
                  id === openId && "border-foreground/50 bg-muted/40",
                )}
              >
                <button
                  type="button"
                  onClick={() => onOpen(id)}
                  aria-current={id === openId ? "true" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-3.5 text-left focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <Avatar name={application.company} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {application.title}
                    </span>
                    <span className="block truncate text-[13px] text-muted-foreground">
                      {application.company}
                      {application.location ? ` · ${application.location}` : ""}
                      {application.appliedAt ? ` · applied ${ago(application.appliedAt)}` : ""}
                    </span>
                    {needsFollowUp(application) && (
                      <span className="mt-0.5 block text-xs font-medium text-amber-700 dark:text-amber-300">
                        No update in a week. Time to follow up?
                      </span>
                    )}
                    {application.note && (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground italic">
                        {application.note}
                      </span>
                    )}
                  </span>
                </button>
                <StatusMenu
                  status={application.status}
                  size="xs"
                  onSet={(status) =>
                    tracker.set(
                      {
                        id: application.jobId,
                        title: application.title,
                        company: application.company,
                        locationText: application.location,
                        applyUrl: application.applyUrl,
                        url: null,
                      },
                      status,
                    )
                  }
                  onRemove={() => tracker.remove(application.jobId)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Chat recommendations are published by the assistant; saved discovery searches use database paging. */
export function JobList({
  spec,
  reviewed = null,
  discovery = false,
  title,
  notes,
  view,
  onView,
  openId,
  working,
  started,
  onOpen,
}: {
  spec: SearchSpec | null;
  /** null means no reviewed selection has been published for this turn; [] is a completed empty selection. */
  reviewed?: JobHit[] | null;
  /** Saved searches are broad catalog discovery, not personal recommendations. */
  discovery?: boolean;
  /** What the list is showing, when it is a saved search; otherwise it is just "Results". */
  title?: string;
  notes: Map<string, Note>;
  view: ListView;
  onView: (view: ListView) => void;
  openId: string | null;
  /** The assistant is working, so a new search may be on its way. */
  working: boolean;
  started: boolean;
  onOpen: (id: string) => void;
}) {
  // The page is an index for one search at a time; a new search starts again at the first page.
  const searchKey = JSON.stringify({ spec, reviewed, discovery });
  const [paging, setPaging] = useState({ key: searchKey, page: 0 });
  const page = paging.key === searchKey ? paging.page : 0;
  const query = useSearchPage(discovery ? spec : null, page * PAGE_SIZE);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [searchKey, page]);

  const hits = discovery
    ? (query.data?.hits ?? [])
    : (reviewed?.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? []);
  const nextOffset = discovery
    ? (query.data?.nextOffset ?? null)
    : reviewed && (page + 1) * PAGE_SIZE < reviewed.length
      ? (page + 1) * PAGE_SIZE
      : null;
  const tracker = useTracker();
  const go = (next: number) => setPaging({ key: searchKey, page: next });

  let body: ReactNode;
  if (view === "tracker") {
    body = <TrackerRows openId={openId} onOpen={onOpen} />;
  } else if (discovery ? !spec : reviewed === null) {
    body = working ? (
      <Skeleton />
    ) : (
      <Empty title={started ? "Results appear here" : "Your results will appear here"}>
        {started
          ? "The assistant has not published reviewed recommendations for this request. Ask it to review and select suitable roles."
          : "Tell the assistant what you're after. It reads postings and selects roles for your background and requirements."}
      </Empty>
    );
  } else if (discovery && query.isError && !query.data) {
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
  } else if (discovery && !query.data) {
    body = <Skeleton />;
  } else if (hits.length === 0) {
    body = (
      <Empty title={discovery ? "No roles match this search" : "No reviewed matches yet"}>
        {discovery
          ? "Try nearby titles or ask the assistant to review this search."
          : "The assistant did not select any reviewed roles. Ask it to explore more postings or adjust your requirements."}
      </Empty>
    );
  } else {
    body = (
      <ul
        className={cn(
          "grid grid-cols-[minmax(0,1fr)] gap-2.5 transition-opacity",
          ((discovery && query.isPlaceholderData) || working) && "opacity-60",
        )}
        aria-label="Search results"
      >
        {hits.map((hit) => (
          <JobRow
            key={hit.id}
            hit={hit}
            note={notes.get(hit.id)}
            status={tracker.of(Number(hit.id))?.status}
            active={hit.id === openId}
            onOpen={onOpen}
          />
        ))}
      </ul>
    );
  }

  const paged = view === "results" && (page > 0 || nextOffset !== null);
  const from = page * PAGE_SIZE + 1;
  const to = page * PAGE_SIZE + hits.length;
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h2 className="truncate text-sm font-medium">
          {view === "tracker" ? "Tracker" : (title ?? "Results")}
        </h2>
        <div
          role="tablist"
          aria-label="List"
          className="flex rounded-lg bg-muted p-0.5 text-[13px]"
        >
          {(["results", "tracker"] as const).map((tab) => (
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
              {tab === "tracker" && <Bookmark className="size-3" aria-hidden />}
              {tab === "results"
                ? "Results"
                : `Tracker${tracker.applications.length ? ` ${tracker.applications.length}` : ""}`}
            </button>
          ))}
        </div>
      </header>

      <div
        ref={scroller}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-4">
          {discovery && view === "results" && (
            <p className="mb-3 text-xs text-muted-foreground">
              Saved search · broad catalog matches, not reviewed for your qualifications.
            </p>
          )}
          {body}
        </div>
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
            onClick={() => go(page - 1)}
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
            onClick={() => nextOffset !== null && go(page + 1)}
            disabled={nextOffset === null || (discovery && query.isPlaceholderData)}
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
