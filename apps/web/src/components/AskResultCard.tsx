import type { Item } from "@tallo/search-ai";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { itemHref } from "@/lib/ask";

/**
 * One ranked answer item. Shows only what the engine returned: the job's own facts are not on
 * this payload, so no pay, work mode or experience badges are invented here.
 */
export function AskResultCard({ item }: { item: Item }) {
  const href = itemHref(item.id);
  return (
    <Card className="relative rounded-xl ring-foreground/10 transition-[shadow,ring-color] duration-150 hover:shadow-md hover:ring-foreground/20">
      <CardContent className="grid gap-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          {href ? (
            <a
              href={href}
              className="font-heading text-base font-medium leading-snug after:absolute after:inset-0 hover:underline"
            >
              {item.title}
            </a>
          ) : (
            <span className="font-heading text-base font-medium leading-snug">{item.title}</span>
          )}
          <Badge variant={item.verdict === "strong" ? "default" : "secondary"}>
            {item.verdict === "strong" ? "Strong fit" : "Possible fit"}
            {item.fit !== null && <span className="tabular-nums">· {Math.round(item.fit)}</span>}
          </Badge>
        </div>

        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{item.company}</span>
          {item.locations.length > 0 && <span> · {item.locations.join(" · ")}</span>}
        </p>

        {item.reason && <p className="text-sm leading-relaxed">{item.reason}</p>}

        {item.evidence.length > 0 && (
          <div className="grid gap-1.5">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Evidence
            </h3>
            <ul className="grid gap-1.5">
              {item.evidence.map((quote) => (
                <li
                  key={quote}
                  className="border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground"
                >
                  “{quote}”
                </li>
              ))}
            </ul>
          </div>
        )}

        {item.unknowns.length > 0 && (
          <div className="grid gap-1">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Unknown
            </h3>
            <ul className="list-inside list-disc text-sm text-muted-foreground">
              {item.unknowns.map((unknown) => (
                <li key={unknown}>{unknown}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
