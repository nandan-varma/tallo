import { Badge } from "@/components/ui/badge";
import { FRESHNESS_LABEL, type Freshness } from "@/lib/status";

const VARIANT: Record<Freshness, "secondary" | "outline" | "destructive"> = {
  fresh: "secondary",
  stale: "outline",
  hidden: "destructive",
};

/** Freshness is inferred from the last listing time, so the badge says so in its tooltip. */
export function FreshnessBadge({ freshness }: { freshness: Freshness }) {
  return (
    <Badge
      variant={VARIANT[freshness]}
      title="Inferred from the last listing: stale after 7 days, hidden from search after 14."
    >
      {FRESHNESS_LABEL[freshness]}
    </Badge>
  );
}
