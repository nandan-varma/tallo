import type { JobHit, SearchPage } from "@tallo/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatPay, postedAgo, safeHref } from "@/lib/search";

/** A page of hits, each linking to the employer's application. Prev and next are plain links. */
export function JobResults({
  hits,
  start,
  prevHref,
  nextHref,
  capped = false,
  expanded,
}: {
  hits: JobHit[];
  /** The 1-based position of the first hit on this page. */
  start: number;
  prevHref: string | null;
  nextHref: string | null;
  /** The API stopped the list at its cap: say so, so the reader narrows instead of paging forever. */
  capped?: boolean;
  expanded?: SearchPage["expanded"];
}) {
  if (hits.length === 0) {
    return (
      <div className="rounded-lg border p-6 text-sm">
        <h2 className="font-semibold">No postings match that search.</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Try a broader title, another location, or fewer filters.
        </p>
      </div>
    );
  }
  return (
    <section aria-label="Results" className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Showing {start}–{start + hits.length - 1}
      </p>
      {capped && (
        <p className="text-sm text-muted-foreground">
          Only the first 300 matches are listed. Narrow the title, add a company, or pick a shorter
          date range to see the rest.
        </p>
      )}
      {expanded && (expanded.locations.length > 0 || expanded.remote) && (
        <p className="text-sm text-muted-foreground">
          {expanded.locations.length > 0
            ? `Includes postings near: ${expanded.locations.join(", ")}. `
            : ""}
          {expanded.remote ? "Remote postings are included." : ""}
        </p>
      )}
      <ol className="grid gap-2">
        {hits.map((hit) => (
          <JobItem key={hit.id} hit={hit} />
        ))}
      </ol>
      <nav aria-label="Pages" className="flex justify-between gap-4 text-sm">
        {prevHref ? (
          <Button asChild variant="outline">
            <a href={prevHref}>Previous</a>
          </Button>
        ) : (
          <span />
        )}
        {nextHref ? (
          <Button asChild variant="outline">
            <a href={nextHref}>Next</a>
          </Button>
        ) : (
          <span />
        )}
      </nav>
    </section>
  );
}

function JobItem({ hit }: { hit: JobHit }) {
  const href = safeHref(hit.applyUrl);
  const age = hit.postedAt ? postedAgo(hit.postedAt) : null;
  const details = [
    hit.company,
    hit.location,
    hit.locations > 1 ? `${hit.locations} locations` : null,
    hit.workMode,
    formatPay(hit.compensation),
    age,
  ].filter((part): part is string => Boolean(part));
  return (
    <li>
      <Card>
        <CardContent className="break-words">
          <div className="flex flex-wrap items-center gap-2">
            {href ? (
              <a
                href={href}
                rel="noopener noreferrer"
                className="font-medium underline-offset-4 hover:underline"
              >
                {hit.title}
              </a>
            ) : (
              <span className="font-semibold">{hit.title}</span>
            )}
            {hit.department && (
              <Badge
                variant="secondary"
                className="max-w-full whitespace-normal break-words"
                title={hit.department}
              >
                {hit.department}
              </Badge>
            )}
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {details.join(" · ")}
          </p>
        </CardContent>
      </Card>
    </li>
  );
}
