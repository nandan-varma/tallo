import { CheckIcon } from "@animateicons/react/lucide";
import type { JobDetail, JobSummary } from "@tallo/contracts";
import {
  ArrowUpRight,
  BriefcaseBusiness,
  Clock3,
  Filter,
  MapPin,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useState } from "react";
import { JobFacts } from "@/components/JobFacts";
import { JobMeta } from "@/components/JobMeta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ago, experience, salary } from "@/lib/format";

const FILTER_KEYS = [
  "workMode",
  "postedWithinDays",
  "country",
  "salaryMin",
  "maxExperience",
  "all",
];
const spring = { type: "spring", stiffness: 380, damping: 34 } as const;

function activeFilterCount(values: Record<string, string>) {
  return FILTER_KEYS.filter((key) => values[key]).length;
}

function Filters({ values, id }: { values: Record<string, string>; id: string }) {
  const v = (name: string) => values[name] ?? "";
  return (
    <fieldset className="grid gap-5" id={id}>
      <legend className="sr-only">Search filters</legend>
      <div className="grid gap-2">
        <Label htmlFor="workMode">Work arrangement</Label>
        <NativeSelect id="workMode" name="workMode" defaultValue={v("workMode")}>
          <NativeSelectOption value="">All arrangements</NativeSelectOption>
          <NativeSelectOption value="remote">Remote</NativeSelectOption>
          <NativeSelectOption value="hybrid">Hybrid</NativeSelectOption>
          <NativeSelectOption value="onsite">On-site</NativeSelectOption>
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="postedWithinDays">Posted</Label>
        <NativeSelect
          id="postedWithinDays"
          name="postedWithinDays"
          defaultValue={v("postedWithinDays")}
        >
          <NativeSelectOption value="">Any time</NativeSelectOption>
          <NativeSelectOption value="1">Past 24 hours</NativeSelectOption>
          <NativeSelectOption value="7">Past week</NativeSelectOption>
          <NativeSelectOption value="30">Past month</NativeSelectOption>
        </NativeSelect>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="country">Country</Label>
          <Input
            id="country"
            name="country"
            defaultValue={v("country")}
            maxLength={2}
            placeholder="US"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="salaryMin">Minimum salary</Label>
          <Input
            id="salaryMin"
            name="salaryMin"
            defaultValue={v("salaryMin")}
            inputMode="numeric"
            placeholder="$100k"
          />
        </div>
      </div>
      <details className="group border-t pt-4">
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          More filters{" "}
          <span aria-hidden="true" className="text-lg transition-transform group-open:rotate-45">
            +
          </span>
        </summary>
        <div className="grid gap-4 pt-4">
          <div className="grid gap-2">
            <Label htmlFor="maxExperience">Maximum experience</Label>
            <Input
              id="maxExperience"
              name="maxExperience"
              defaultValue={v("maxExperience")}
              inputMode="numeric"
              placeholder="Years"
            />
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              name="all"
              value="true"
              defaultChecked={v("all") === "true"}
              className="size-4 rounded accent-primary"
            />
            Include hidden jobs
          </label>
        </div>
      </details>
    </fieldset>
  );
}

function ResultCard({
  job,
  selected,
  onOpen,
}: {
  job: JobSummary;
  selected: boolean;
  onOpen: (job: JobSummary) => void;
}) {
  const pay = salary(job);
  return (
    <motion.li layout="position" transition={spring}>
      <a
        href={`/jobs/${job.id}`}
        aria-current={selected ? "page" : undefined}
        onClick={(event) => {
          event.preventDefault();
          onOpen(job);
        }}
        className={`group block rounded-2xl border p-4 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${selected ? "border-primary bg-primary/[0.055]" : "border-border bg-card hover:border-primary/35 hover:bg-muted/45"}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-heading text-[0.98rem] font-semibold tracking-tight group-hover:text-primary">
              {job.title}
            </h3>
            <p className="mt-1 text-sm font-medium text-foreground/80">{job.company}</p>
          </div>
          {job.workMode && (
            <Badge variant="secondary" className="shrink-0 capitalize">
              {job.workMode}
            </Badge>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          {job.locationText && (
            <span className="flex items-center gap-1">
              <MapPin className="size-3.5" aria-hidden="true" />
              {job.locationText}
            </span>
          )}
          {job.postedAt && (
            <span className="flex items-center gap-1">
              <Clock3 className="size-3.5" aria-hidden="true" />
              {ago(job.postedAt ?? job.sortAt)}
            </span>
          )}
          {experience(job.expMinYears) && <span>{experience(job.expMinYears)}</span>}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="line-clamp-1 text-xs text-muted-foreground">{job.excerpt}</span>
          {pay && <span className="shrink-0 text-xs font-semibold tabular-nums">{pay}</span>}
        </div>
      </a>
    </motion.li>
  );
}

function Detail({
  job,
  loading,
  onClose,
}: {
  job: JobDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  if (loading)
    return (
      <div className="grid gap-5 p-6" aria-live="polite">
        <span className="sr-only">Loading job details</span>
        <div className="h-7 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-36 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  if (!job) return null;
  const link = job.applyUrl ?? job.url;
  return (
    <motion.article
      key={job.id}
      initial={{ opacity: 0, x: 22 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 12 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className="grid gap-6 p-5 sm:p-7"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-primary">{job.company}</p>
          <h2 className="mt-1 font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            {job.title}
          </h2>
          <div className="mt-3">
            <JobMeta job={job} extended />
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close job details">
          <X />
        </Button>
      </div>
      {link && (
        <Button asChild className="w-full sm:w-fit">
          <a href={link} target="_blank" rel="noreferrer">
            Apply on {job.company}
            <ArrowUpRight />
          </a>
        </Button>
      )}
      <div className="border-y py-5">
        <JobFacts facts={job.facts} />
      </div>
      <section aria-labelledby="description-heading" className="grid gap-3">
        <h3 id="description-heading" className="font-heading text-base font-semibold">
          About this role
        </h3>
        <div className="max-w-prose whitespace-pre-wrap break-words text-[0.95rem] leading-7 text-foreground/85">
          {job.description ?? "Description unavailable."}
        </div>
      </section>
    </motion.article>
  );
}

export function JobExplorer({
  jobs,
  nextCursor,
  values,
}: {
  jobs: JobSummary[];
  nextCursor: string | null;
  values: Record<string, string>;
}) {
  const [selected, setSelected] = useState<JobSummary | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const reduced = useReducedMotion();
  const filterId = useId();
  const active = activeFilterCount(values);
  const hasSelection = Boolean(selected);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setLoading(true);
    setDetail(null);
    fetch(`/api/jobs/${selected.id}.json`, { signal: controller.signal })
      .then((response) =>
        response.ok ? (response.json() as Promise<JobDetail>) : Promise.reject(),
      )
      .then((job) => setDetail(job))
      .catch(() => {
        if (!controller.signal.aborted) setDetail(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selected]);
  const query = new URLSearchParams(values);
  if (nextCursor) query.set("cursor", nextCursor);
  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup>
        <section aria-label="Job search" className="grid gap-6">
          <div className="grid gap-2">
            <div className="flex items-center gap-2 text-primary">
              <BriefcaseBusiness className="size-4" aria-hidden="true" />
              <span className="text-xs font-semibold tracking-[0.16em] uppercase">
                Curated tech roles
              </span>
            </div>
            <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
              Find work worth doing.
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              Search fresh roles with pay, location, and experience facts already parsed for you.
            </p>
          </div>
          <motion.form
            method="get"
            layout
            transition={spring}
            className={`grid items-start gap-5 ${hasSelection ? "xl:grid-cols-[minmax(22rem,0.82fr)_minmax(0,1.18fr)]" : "xl:grid-cols-[minmax(0,1fr)_19rem]"}`}
          >
            <motion.div layout="position" className="min-w-0 grid gap-5">
              <motion.div layout="position" className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <Label htmlFor="q" className="sr-only">
                    Search jobs
                  </Label>
                  <Search
                    className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    id="q"
                    name="q"
                    defaultValue={values.q ?? ""}
                    placeholder="Search title, company, or place"
                    className="h-12 rounded-xl pl-11 text-base shadow-sm"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className={`h-12 rounded-xl px-4 ${hasSelection ? "" : "xl:hidden"}`}
                  aria-expanded={filtersOpen}
                  aria-controls={filterId}
                  onClick={() => setFiltersOpen((open) => !open)}
                >
                  <SlidersHorizontal /> <span className="hidden sm:inline">Filters</span>
                  {active > 0 && (
                    <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                      {active}
                    </span>
                  )}
                </Button>
              </motion.div>
              <AnimatePresence initial={false}>
                {filtersOpen && (
                  <motion.aside
                    id={filterId}
                    initial={reduced ? false : { opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={reduced ? undefined : { opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden xl:hidden"
                  >
                    <div className="rounded-2xl border bg-card p-5">
                      <Filters values={values} id={`${filterId}-mobile`} />
                      <div className="mt-5 flex gap-2">
                        <Button type="submit" className="flex-1">
                          Update results
                        </Button>
                        {active > 0 && (
                          <Button variant="ghost" asChild>
                            <a href="/">Clear</a>
                          </Button>
                        )}
                      </div>
                    </div>
                  </motion.aside>
                )}
              </AnimatePresence>
              <section aria-label="Search results" className="grid gap-3">
                <div className="flex items-center justify-between px-1">
                  <p className="text-sm text-muted-foreground">
                    <strong className="font-semibold text-foreground">{jobs.length}</strong> roles
                    to explore
                  </p>
                  {active > 0 && (
                    <Badge variant="secondary">
                      {active} filter{active === 1 ? "" : "s"}
                    </Badge>
                  )}
                </div>
                {jobs.length ? (
                  <motion.ul layout className="grid gap-2.5">
                    {jobs.map((job) => (
                      <ResultCard
                        key={job.id}
                        job={job}
                        selected={selected?.id === job.id}
                        onOpen={(next) => {
                          setSelected(next);
                          setFiltersOpen(false);
                        }}
                      />
                    ))}
                  </motion.ul>
                ) : (
                  <div className="rounded-2xl border border-dashed bg-muted/35 p-10 text-center">
                    <p className="font-semibold">No roles match that search.</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Try a broader term or fewer filters.
                    </p>
                    <Button variant="outline" asChild className="mt-4">
                      <a href="/">Reset search</a>
                    </Button>
                  </div>
                )}
                {nextCursor && (
                  <Button variant="outline" asChild className="justify-self-center">
                    <a href={`/?${query}`}>Load more roles</a>
                  </Button>
                )}
              </section>
            </motion.div>
            <AnimatePresence initial={false} mode="popLayout">
              {hasSelection ? (
                <motion.aside
                  layout="position"
                  initial={reduced ? false : { opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={spring}
                  aria-label="Selected job"
                  className="overflow-hidden rounded-2xl border bg-card shadow-sm xl:sticky xl:top-20"
                >
                  <Detail
                    job={detail}
                    loading={loading}
                    onClose={() => {
                      setSelected(null);
                      setDetail(null);
                    }}
                  />
                </motion.aside>
              ) : (
                <motion.aside layout="position" className="hidden xl:block">
                  <div className="rounded-2xl border bg-card p-5 shadow-sm">
                    <div className="mb-5 flex items-center justify-between">
                      <div>
                        <h2 className="font-heading font-semibold">Refine your search</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Use the details that matter.
                        </p>
                      </div>
                      <Filter className="size-5 text-primary" aria-hidden="true" />
                    </div>
                    <Filters values={values} id={`${filterId}-desktop`} />
                    <div className="mt-5 flex gap-2">
                      <Button type="submit" className="flex-1">
                        Show roles
                      </Button>
                      {active > 0 && (
                        <Button variant="ghost" asChild>
                          <a href="/">Clear</a>
                        </Button>
                      )}
                    </div>
                  </div>
                </motion.aside>
              )}
            </AnimatePresence>
          </motion.form>
          {!hasSelection && (
            <div className="hidden xl:grid min-h-72 place-items-center rounded-2xl border border-dashed bg-primary/[0.025] text-center">
              <div className="grid justify-items-center gap-4">
                <span className="grid size-24 place-items-center rounded-full bg-primary shadow-lg shadow-primary/20">
                  <CheckIcon size={64} duration={1} color="#ffffff" />
                </span>
                <div>
                  <p className="font-heading text-lg font-semibold">A better way to browse</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Choose a role to open its full story here.
                  </p>
                </div>
              </div>
            </div>
          )}
        </section>
      </LayoutGroup>
    </MotionConfig>
  );
}
