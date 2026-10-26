import type { JobVariant } from "@tallo/contracts";
import { ArrowUpRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const placeOf = (v: JobVariant) =>
  v.locationText ??
  ([v.city, v.region, v.countryCode].filter(Boolean).join(", ") || "Location not listed");

/**
 * The same posting listed for other locations. Search shows a posting once; this is where its other
 * locations (and their own apply links) are.
 */
export function Variants({
  variants,
  currentId,
}: {
  variants: JobVariant[] | undefined;
  currentId: number;
}) {
  const others = (variants ?? []).filter((v) => v.id !== currentId);
  if (others.length === 0) return null;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          Also open in{" "}
          {others.length === 1 ? "1 other location" : `${others.length} other locations`}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 text-sm">
          {others.map((v) => {
            const link = v.applyUrl ?? v.url;
            return (
              <li key={v.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {placeOf(v)}
                  {v.workMode && (
                    <span className="ml-1.5 text-muted-foreground capitalize">{v.workMode}</span>
                  )}
                </span>
                {link && (
                  <a
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex shrink-0 items-center gap-0.5 text-[13px] font-medium underline-offset-4 hover:underline"
                  >
                    Apply
                    <ArrowUpRight className="size-3.5" aria-hidden />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
