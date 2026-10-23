import type { JobLocation, Money, Quantity } from "@tallo/contracts";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type JobFacts as Facts, readFacts } from "@/lib/facts";
import {
  extraRows,
  formatLocation,
  formatPay,
  formatQuantity,
  KIND_LABEL,
  sortLocations,
} from "@/lib/format";

/** Marks values parsed from free text rather than structured source fields. */
function FromText() {
  return (
    <Badge variant="ghost" title="Parsed from the job text, not a structured source field">
      from text
    </Badge>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

export function Locations({ locations }: { locations: JobLocation[] }) {
  return (
    <ul className="grid gap-1.5 text-sm">
      {sortLocations(locations).map((location) => (
        <li key={JSON.stringify(location)} className="flex flex-wrap items-center gap-2">
          <span>{formatLocation(location)}</span>
          {location.primary && <Badge variant="secondary">Primary</Badge>}
          {location.remote && <Badge variant="outline">Remote</Badge>}
        </li>
      ))}
    </ul>
  );
}

export function PayBands({ bands }: { bands: Money[] }) {
  return (
    <ul className="grid gap-1.5 text-sm">
      {bands.map((band) => (
        <li key={JSON.stringify(band)} className="flex flex-wrap items-center gap-2">
          <span>{formatPay(band)}</span>
          {band.inferred && <FromText />}
        </li>
      ))}
    </ul>
  );
}

export function Requirements({ items }: { items: Quantity[] }) {
  return (
    <ul className="grid gap-1.5 text-sm">
      {items.map((item) => (
        <li key={JSON.stringify(item)} className="flex flex-wrap items-center gap-2">
          <span>{formatQuantity(item)}</span>
          {KIND_LABEL[item.kind] && <Badge variant="outline">{KIND_LABEL[item.kind]}</Badge>}
          {item.inferred && <FromText />}
          {item.text && <span className="text-muted-foreground">“{item.text}”</span>}
        </li>
      ))}
    </ul>
  );
}

export function Extras({ extras }: { extras: Record<string, unknown> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {extraRows(extras).map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Structured job facts. Empty sections are omitted; with nothing to show, renders nothing. */
export function JobFacts({ facts }: { facts: Record<string, unknown> }) {
  const f: Facts = readFacts(facts);
  const rows = extraRows(f.extras);
  if (!f.locations.length && !f.compensation.length && !f.experience.length && !rows.length) {
    return null;
  }
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Facts</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {f.locations.length > 0 && (
          <Section title="Locations">
            <Locations locations={f.locations} />
          </Section>
        )}
        {f.compensation.length > 0 && (
          <Section title="Pay">
            <PayBands bands={f.compensation} />
          </Section>
        )}
        {f.experience.length > 0 && (
          <Section title="Experience">
            <Requirements items={f.experience} />
          </Section>
        )}
        {rows.length > 0 && (
          <Section title="Source details">
            <Extras extras={f.extras} />
          </Section>
        )}
      </CardContent>
    </Card>
  );
}
