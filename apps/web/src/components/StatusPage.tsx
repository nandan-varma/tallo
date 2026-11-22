import type { SiteStats } from "@tallo/contracts";

const nf = new Intl.NumberFormat("en-US");
const num = (n: number) => nf.format(Math.round(n));
const pct = (share: number) => `${nf.format(Math.round(share * 100))}%`;
const ratio = (part: number, whole: number) => (whole ? part / whole : 0);

const DATE = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const stamp = (epoch: number) => `${DATE.format(new Date(epoch * 1000))} UTC`;

const regions = new Intl.DisplayNames(["en"], { type: "region" });
const countryName = (code: string) => {
  try {
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
};

/** "3 hours ago" style age, from two epoch seconds. */
function ago(from: number, to: number): string {
  const s = Math.max(0, to - from);
  if (s < 90) return "moments ago";
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function Card({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="grid content-start gap-1 rounded-xl border bg-card p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-3xl font-semibold tracking-tight tabular-nums">{value}</dd>
      {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-4 break-inside-avoid">
      <div className="grid gap-1">
        <h2 id={id} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {lead ? <p className="text-sm text-muted-foreground">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}

interface Row {
  label: string;
  /** 0 to 1: the bar's length. */
  fraction: number;
  value: string;
  extra?: string;
}

/** Horizontal bars as a real table: the bar is decoration, the numbers are the content. */
function Bars({ caption, rows, column }: { caption: string; rows: Row[]; column: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Share of the largest</th>
            <th scope="col">{column}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th
                scope="row"
                className="w-[38%] truncate py-1.5 pr-3 text-left font-normal sm:w-[30%]"
                title={row.label}
              >
                {row.label}
              </th>
              <td className="py-1.5" aria-hidden="true">
                <div className="h-2 rounded-full bg-border">
                  <div
                    className="h-2 rounded-full bg-foreground/80"
                    style={{ width: `${Math.max(1, Math.round(row.fraction * 100))}%` }}
                  />
                </div>
              </td>
              <td className="w-[5.5rem] py-1.5 pl-3 text-right tabular-nums sm:w-28">
                {row.value}
                {row.extra ? (
                  <span className="block text-xs text-muted-foreground">{row.extra}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function bars(items: { label: string; n: number; value?: string; extra?: string }[]): Row[] {
  const max = Math.max(1, ...items.map((i) => i.n));
  return items.map((i) => ({
    label: i.label,
    fraction: i.n / max,
    value: i.value ?? num(i.n),
    extra: i.extra,
  }));
}

/** One 100% stacked bar with a legend table beneath it. */
function Split({ caption, parts }: { caption: string; parts: { label: string; share: number }[] }) {
  const tones = ["bg-foreground", "bg-foreground/60", "bg-foreground/35", "bg-border"];
  return (
    <div className="grid gap-3 rounded-xl border bg-card p-4">
      <div className="flex h-3 overflow-hidden rounded-full bg-border" aria-hidden="true">
        {parts.map((p, i) => (
          <div
            key={p.label}
            className={tones[i % tones.length]}
            style={{ width: `${p.share * 100}%` }}
          />
        ))}
      </div>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <tbody>
          {parts.map((p, i) => (
            <tr key={p.label}>
              <th scope="row" className="py-1 text-left font-normal">
                <span
                  aria-hidden="true"
                  className={`mr-2 inline-block size-2.5 rounded-sm border ${tones[i % tones.length]}`}
                />
                {p.label}
              </th>
              <td className="py-1 text-right tabular-nums">{pct(p.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Meter({ label, share, note }: { label: string; share: number; note: string }) {
  return (
    <div className="grid gap-2 rounded-xl border bg-card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{pct(share)}</span>
      </div>
      <div
        className="h-2 rounded-full bg-border"
        role="img"
        aria-label={`${pct(share)} ${label.toLowerCase()}`}
      >
        <div className="h-2 rounded-full bg-foreground/80" style={{ width: `${share * 100}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

const STEPS = [
  [
    "Collect",
    "A runner reads each employer's own job board on a schedule and keeps every field the source returns.",
  ],
  [
    "Store what sources state",
    "Facts go in as stated. Nothing is inferred: a blank stays blank and is shown as not stated.",
  ],
  [
    "Search",
    "A public, read-only API and this site search the catalog and link straight to the employer's application.",
  ],
];

export function StatusPage({ stats, now }: { stats: SiteStats | null; now: number }) {
  return (
    <div className="mx-auto grid max-w-4xl gap-12 px-4 py-10 sm:px-6 sm:py-14">
      <header className="grid gap-3">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Tallo status</h1>
        <p className="max-w-prose text-muted-foreground">
          What the catalog holds and how fresh it is, counted from the live database. Figures marked
          approximate come from each board's last complete listing or from a sample of postings.
          Nothing here is inferred.
        </p>
        {stats ? (
          <p className="text-sm text-muted-foreground">
            Data as of{" "}
            <time dateTime={new Date(stats.asOf * 1000).toISOString()}>{stamp(stats.asOf)}</time>{" "}
            (refreshed about twice a day).
          </p>
        ) : null}
      </header>

      {stats ? <Body stats={stats} now={now} /> : <Unavailable />}

      <Section id="facts" title="Product facts">
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {[
            "No accounts and no sign-in.",
            "Nothing about you is stored. There is no tracking or analytics.",
            "Every result links straight to the employer's own application.",
            "A public, read-only API, described for AI assistants in llms.txt and in OpenAPI.",
          ].map((fact) => (
            <li key={fact} className="rounded-xl border bg-card p-4">
              {fact}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="how" title="How it works">
        <ol className="grid gap-3 sm:grid-cols-3">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="grid content-start gap-1 rounded-xl border bg-card p-4">
              <span className="text-xs text-muted-foreground tabular-nums">Step {i + 1}</span>
              <span className="font-medium">{title}</span>
              <span className="text-sm text-muted-foreground">{text}</span>
            </li>
          ))}
        </ol>
      </Section>

      <nav aria-label="Links" className="flex flex-wrap gap-x-6 gap-y-2 text-sm print:hidden">
        <a href="/search" className="underline underline-offset-4">
          Search jobs
        </a>
        <a href="/llms.txt" className="underline underline-offset-4">
          llms.txt
        </a>
        <a href="/v1/openapi.json" className="underline underline-offset-4">
          OpenAPI (JSON)
        </a>
      </nav>
    </div>
  );
}

function Unavailable() {
  return (
    <div role="status" className="rounded-xl border bg-card p-6">
      <p className="font-medium">The numbers are not available right now.</p>
      <p className="mt-1 text-sm text-muted-foreground">
        The catalog is fine to search; only this snapshot could not be read. Try again in a few
        minutes.
      </p>
    </div>
  );
}

function Body({ stats, now }: { stats: SiteStats; now: number }) {
  const { freshness: f, mix } = stats;
  const sampleNote = `Sample of ${num(stats.sampleSize)} open postings spread across the catalog.`;
  return (
    <>
      <Section id="headline" title="At a glance">
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Card label="Open jobs" value={num(stats.openJobs)} note="approximate" />
          <Card label="Employers" value={num(stats.employers)} />
          <Card label="Boards tracked" value={num(stats.boards)} />
          <Card label="Platforms" value={num(stats.platforms)} />
          <Card label="Countries" value={num(stats.countries.distinct)} note="seen in the sample" />
        </dl>
      </Section>

      <Section
        id="fresh"
        title="Freshness"
        lead="Postings from a board that has not listed for 14 days are hidden from search."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Meter
            label="of boards listed in the last 7 days"
            share={ratio(f.listed7d, stats.boards)}
            note={`${num(f.listed7d)} of ${num(stats.boards)} boards`}
          />
          <Meter
            label="of boards listed in the last 14 days"
            share={ratio(f.listed14d, stats.boards)}
            note={`${num(f.listed14d)} of ${num(stats.boards)} boards`}
          />
        </div>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card
            label="Newest collection run"
            value={f.newestRunAt ? ago(f.newestRunAt, now) : "none yet"}
            note={f.newestRunAt ? stamp(f.newestRunAt) : undefined}
          />
          <Card label="New postings, 24 hours" value={num(f.added24h)} />
          <Card label="New postings, 7 days" value={num(f.added7d)} />
          <Card label="Closed, 7 days" value={num(f.closed7d)} />
        </dl>
      </Section>

      <Section
        id="platforms"
        title="Open jobs by platform"
        lead="Applicant tracking systems read, with their boards."
      >
        <Bars
          caption="Open jobs by platform"
          column="Open jobs"
          rows={bars(
            stats.byPlatform.map((p) => ({
              label: p.platform,
              n: p.open,
              extra: `${num(p.boards)} ${p.boards === 1 ? "board" : "boards"}`,
            })),
          )}
        />
      </Section>

      <Section id="employers" title="Top employers" lead="By open postings, approximate.">
        <Bars
          caption="Top 15 employers by open postings"
          column="Open jobs"
          rows={bars(stats.topEmployers.map((e) => ({ label: e.name, n: e.open })))}
        />
      </Section>

      <Section
        id="countries"
        title="Top countries"
        lead={`Share of postings, approximate. ${sampleNote}`}
      >
        <Bars
          caption="Top 12 countries by share of open postings"
          column="Share"
          rows={bars(
            stats.countries.top.map((c) => ({
              label: countryName(c.code),
              n: c.share,
              value: pct(c.share),
            })),
          )}
        />
        <p className="text-xs text-muted-foreground">
          {pct(1 - mix.countryStated)} of postings do not state a country: not stated by the source.
        </p>
      </Section>

      <Section id="mix" title="What postings state" lead={sampleNote}>
        <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
          <Split
            caption="Work mode of open postings"
            parts={[
              { label: "Remote", share: mix.remote },
              { label: "Hybrid", share: mix.hybrid },
              { label: "On-site", share: mix.onsite },
              { label: "Not stated by the source", share: mix.unstated },
            ]}
          />
          <div className="grid gap-3">
            <Meter
              label="state pay"
              share={mix.payStated}
              note="Pay is shown only when the source states it."
            />
            <Meter
              label="state a posted date"
              share={mix.postedStated}
              note="Otherwise not stated by the source."
            />
          </div>
        </div>
      </Section>
    </>
  );
}
