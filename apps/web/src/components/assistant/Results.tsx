import type { JobSummary } from "@tallo/contracts";
import type { JobHit } from "@tallo/search-ai";
import { Bookmark, SearchX } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Avatar, ResultCard } from "@/components/assistant/ResultCard";
import { payLabel, type Ranking } from "@/lib/assistant";
import { cn } from "@/lib/utils";

function Shimmer({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

function SkeletonCard() {
  return (
    <li className="rounded-xl border bg-card p-4">
      <div className="flex gap-3">
        <Shimmer className="size-9 rounded-lg" />
        <div className="grid flex-1 gap-2">
          <Shimmer className="h-4 w-2/3" />
          <Shimmer className="h-3 w-1/2" />
          <Shimmer className="mt-1 h-3 w-full" />
          <Shimmer className="h-3 w-4/5" />
        </div>
      </div>
    </li>
  );
}

function Placeholder({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-24 text-center">
      <SearchX className="mb-3 size-8 text-muted-foreground/50" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {children && (
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{children}</p>
      )}
    </div>
  );
}

/** Roles the search found, shown the moment they arrive, while the ranking is still being written. */
function Considering({ hits }: { hits: JobHit[] }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        Considering {hits.length.toLocaleString("en-US")} roles
      </p>
      <ul className="grid gap-px overflow-hidden rounded-xl border bg-border">
        {hits.slice(0, 6).map((hit, i) => (
          <motion.li
            key={hit.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: i * 0.04 }}
            className="flex items-center gap-3 bg-card px-3.5 py-2.5"
          >
            <Avatar name={hit.company} className="size-7 text-xs" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{hit.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {hit.company}
                {hit.location ? ` · ${hit.location}` : ""}
                {hit.pay ? ` · ${payLabel(hit.pay)}` : ""}
              </span>
            </span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

function SavedList({ saved, onOpen }: { saved: JobSummary[]; onOpen: (id: string) => void }) {
  if (saved.length === 0) {
    return (
      <Placeholder title="Nothing saved yet">
        Open a role and tap the bookmark to keep it here.
      </Placeholder>
    );
  }
  return (
    <ul className="grid gap-3">
      {[...saved].reverse().map((job) => (
        <li key={job.id}>
          <button
            type="button"
            onClick={() => onOpen(String(job.id))}
            className="flex w-full items-center gap-3 rounded-xl border bg-card p-3.5 text-left shadow-xs transition-all hover:border-foreground/30 hover:shadow-sm"
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
      ))}
    </ul>
  );
}

export type ResultsView = "matches" | "saved";

export function Results({
  ranking,
  candidates,
  busy,
  started,
  saved,
  view,
  onView,
  activeId,
  onOpen,
}: {
  ranking: Ranking;
  candidates: JobHit[];
  busy: boolean;
  /** Has the person said anything yet. */
  started: boolean;
  saved: JobSummary[];
  view: ResultsView;
  onView: (view: ResultsView) => void;
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  const savedIds = new Set(saved.map((job) => String(job.id)));
  const ranking_ = ranking.state === "ranking";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4 sm:px-6">
        <h2 className="text-sm font-medium">
          {view === "saved" ? "Saved roles" : "Best matches"}
          {view === "matches" && ranking.matches.length > 0 && (
            <span className="ml-2 font-normal text-muted-foreground tabular-nums">
              {ranking.matches.length}
            </span>
          )}
        </h2>
        <div
          role="tablist"
          aria-label="Results view"
          className="flex rounded-lg bg-muted p-0.5 text-[13px]"
        >
          {(["matches", "saved"] as const).map((tab) => (
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
              {tab === "matches" ? "Matches" : `Saved${saved.length ? ` ${saved.length}` : ""}`}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6">
          {view === "saved" ? (
            <SavedList saved={saved} onOpen={onOpen} />
          ) : ranking.matches.length > 0 ? (
            <ol className="grid gap-3" aria-label="Ranked matches">
              <AnimatePresence initial={false}>
                {ranking.matches.map((match) => (
                  <ResultCard
                    key={match.id}
                    match={match}
                    saved={savedIds.has(match.id)}
                    active={match.id === activeId}
                    onOpen={onOpen}
                  />
                ))}
                {ranking_ && <SkeletonCard key="more" />}
              </AnimatePresence>
            </ol>
          ) : busy && candidates.length > 0 ? (
            <div className="grid gap-4">
              <Considering hits={candidates} />
              <ul className="grid gap-3">
                <SkeletonCard />
              </ul>
            </div>
          ) : busy ? (
            <ul className="grid gap-3" aria-label="Searching">
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </ul>
          ) : ranking.state === "done" ? (
            <Placeholder title="Nothing fits well yet">
              Try loosening the location or seniority, or describe a nearby role.
            </Placeholder>
          ) : started ? (
            <Placeholder title="Matches appear here">
              Once I have enough to search, the best fits show up first.
            </Placeholder>
          ) : (
            <Placeholder title="Your matches will appear here">
              Tell the assistant what you're after. Each result explains why it fits and what the
              posting leaves out.
            </Placeholder>
          )}
        </div>
      </div>
    </div>
  );
}
