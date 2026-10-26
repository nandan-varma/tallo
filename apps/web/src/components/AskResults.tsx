import type { SearchResult } from "@tallo/search-ai";
import { AskResultCard } from "@/components/AskResultCard";
import { sortByRank, traceSections } from "@/lib/ask";

/**
 * Ranked answer plus the trace. An empty answer is a result, not an error: the engine returns
 * nothing when no candidate fits, and the copy says so rather than inventing weak matches.
 */
export function AskResults({
  result,
  elapsedSeconds,
}: {
  result: SearchResult;
  elapsedSeconds?: number;
}) {
  const items = sortByRank(result.answer.items);
  const sections = traceSections(result.trace, elapsedSeconds);
  return (
    <section aria-label="Results" className="grid gap-4">
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-6 text-sm">
          <p className="font-medium">No good matches</p>
          <p className="mt-1 text-muted-foreground">
            Nothing in the current catalog fit this query and profile. Try different titles or
            loosen the profile.
          </p>
        </div>
      ) : (
        <ol className="grid gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <AskResultCard item={item} />
            </li>
          ))}
        </ol>
      )}

      <details className="rounded-xl border border-border bg-card text-sm">
        <summary className="cursor-pointer px-4 py-3 font-medium select-none">Trace</summary>
        <div className="grid gap-4 border-t border-border px-4 py-3">
          {sections.length === 0 ? (
            <p className="text-muted-foreground">The server did not report any trace fields.</p>
          ) : (
            sections.map((section) => (
              <div key={section.title} className="grid gap-1.5">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {section.title}
                </h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
                  {section.rows.map((row) => (
                    <div key={row.label} className="contents">
                      <dt className="text-muted-foreground">{row.label}</dt>
                      <dd className="text-right tabular-nums sm:text-left">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))
          )}
        </div>
      </details>
    </section>
  );
}
