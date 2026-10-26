import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ago, number } from "@/lib/format";
import type { SourceSummary } from "@/lib/status";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint && <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>}
    </Card>
  );
}

/** Headline freshness numbers for the status page. Counts are exact; the freshness split is inferred. */
export function CollectionSummary({ summary, now }: { summary: SourceSummary; now: number }) {
  const collected = summary.total - summary.neverCollected;
  return (
    <section aria-label="Collection summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Last collected" value={ago(summary.lastCollectedAt, now) ?? "Never"} />
      <Stat
        label="Fresh sources"
        value={number.format(summary.fresh)}
        hint={`of ${number.format(collected)} collected`}
      />
      <Stat label="Stale" value={number.format(summary.stale)} hint="Not listed for 7+ days" />
      <Stat
        label="Hidden from search"
        value={number.format(summary.hidden)}
        hint={`Not listed for 14+ days · ${number.format(summary.neverCollected)} never collected`}
      />
    </section>
  );
}
