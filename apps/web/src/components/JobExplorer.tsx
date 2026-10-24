import { CheckIcon } from "@animateicons/react/lucide";
import type { JobDetail, JobSummary } from "@tallo/contracts";
import {
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Check,
  MapPin,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { JobFilters } from "@/components/JobFilters";
import { RoleDetail } from "@/components/RoleDetail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ago, salary } from "@/lib/format";
import { readSavedJobs } from "@/lib/saved-jobs";

const savedStorageKey = "tallo:saved-roles";
const filterKeys = ["workMode", "postedWithinDays", "country", "salaryMin", "maxExperience", "all"];
export function JobExplorer({
  jobs,
  nextCursor,
  values,
}: {
  jobs: JobSummary[];
  nextCursor: string | null;
  values: Record<string, string>;
}) {
  const [selected, setSelected] = useState<JobSummary | null>(
    values.saved === "true" ? null : (jobs[0] ?? null),
  );
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [compact, setCompact] = useState(false);
  const [saved, setSaved] = useState<JobSummary[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [sort, setSort] = useState("newest");
  const cache = useRef(new Map<number, { job: JobDetail; expires: number }>());
  const lastOpened = useRef<HTMLAnchorElement | null>(null);
  const filtersTrigger = useRef<HTMLButtonElement>(null);
  const detailPane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (detailPane.current) detailPane.current.scrollTop = 0;
  }, [selected?.id]);
  const savedView = values.saved === "true";
  const active = filterKeys.filter((key) => values[key]).length;
  const shownJobs = [...(savedView ? saved : jobs)].sort((a, b) =>
    sort === "salary"
      ? (b.salaryMaxAnnual ?? b.salaryMinAnnual ?? -1) -
        (a.salaryMaxAnnual ?? a.salaryMinAnnual ?? -1)
      : b.sortAt - a.sortAt,
  );
  useEffect(() => {
    try {
      setSaved(readSavedJobs(localStorage.getItem(savedStorageKey)));
    } catch {
      /* A fresh collection is available when storage is unavailable. */
    }
    setStorageReady(true);
  }, []);
  useEffect(() => {
    if (!storageReady) return;
    if (savedView)
      setSelected((current) => saved.find((job) => job.id === current?.id) ?? saved[0] ?? null);
  }, [savedView, saved, storageReady]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!selected) return;
    const cached = cache.current.get(selected.id);
    setError(false);
    if (cached && cached.expires > Date.now()) {
      setDetail(cached.job);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setDetail(null);
    fetch(`/api/jobs/${selected.id}.json`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Unavailable");
        return response.json() as Promise<JobDetail>;
      })
      .then((job) => {
        if (controller.signal.aborted) return;
        cache.current.set(job.id, { job, expires: Date.now() + 300000 });
        setDetail(job);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selected, retry]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      setCompact(media.matches);
      if (!media.matches) {
        setMobileDetail(false);
        setFiltersOpen(false);
      }
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  function toggleSave(job: JobSummary) {
    const exists = saved.some((item) => item.id === job.id);
    const next = exists ? saved.filter((item) => item.id !== job.id) : [...saved, job];
    setSaved(next);
    try {
      localStorage.setItem(savedStorageKey, JSON.stringify(next));
      setNotice(exists ? "Job removed from saved" : "Job saved");
    } catch {
      setNotice("Saved for this visit. Browser storage is unavailable.");
    }
  }
  function linkWith(name: string, value: string) {
    const query = new URLSearchParams(values);
    query.delete("cursor");
    query.delete("saved");
    if (value) query.set(name, value);
    else query.delete(name);
    return `/?${query}`;
  }
  const next = new URLSearchParams(values);
  if (nextCursor) next.set("cursor", nextCursor);
  const detailContent = selected && (
    <RoleDetail
      job={selected}
      detail={detail}
      loading={loading}
      error={error}
      saved={saved.some((job) => job.id === selected.id)}
      onSave={() => toggleSave(selected)}
      onRetry={() => setRetry((value) => value + 1)}
    />
  );
  return (
    <MotionConfig reducedMotion="user">
      <div className={`job-workspace ${savedView ? "saved-workspace" : ""}`}>
        {!savedView && (
          <aside className="desktop-filters" aria-label="Job filters">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Filters</h2>
              {active > 0 && (
                <Button asChild variant="ghost" size="sm">
                  <a href={values.q ? `/?q=${encodeURIComponent(values.q)}` : "/"}>Reset</a>
                </Button>
              )}
            </div>
            <JobFilters values={values} />
          </aside>
        )}
        <div className="job-content">
          <header className="mb-4 flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold tracking-tight">
              {savedView ? "Saved jobs" : "Jobs"}
              <span className="ml-2.5 text-sm font-normal text-muted-foreground">
                {shownJobs.length}
                {nextCursor && !savedView ? "+" : ""}
              </span>
            </h1>
            {savedView && <p className="text-xs text-muted-foreground">Saved in this browser</p>}
          </header>
          {!savedView && (
            <search>
              <form method="get" className="mb-3 flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <Label htmlFor="job-search" className="sr-only">
                    Search jobs
                  </Label>
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="h-10 bg-card pl-9"
                    id="job-search"
                    name="q"
                    defaultValue={values.q ?? ""}
                    placeholder="Job title, company, or keyword"
                  />
                </div>
                {filterKeys
                  .filter((key) => values[key])
                  .map((key) => (
                    <input key={key} type="hidden" name={key} value={values[key]} />
                  ))}
                <Button type="submit" className="h-10 px-4">
                  Search
                </Button>
              </form>
            </search>
          )}
          <div className="results-controls">
            <div className="flex flex-wrap items-center gap-2">
              {!savedView && (
                <>
                  <Button
                    variant="outline"
                    className="lg:hidden"
                    ref={filtersTrigger}
                    onClick={() => setFiltersOpen(true)}
                  >
                    <SlidersHorizontal />
                    Filters{active > 0 && <Badge variant="secondary">{active}</Badge>}
                  </Button>
                  <Button asChild variant={values.workMode === "remote" ? "secondary" : "outline"}>
                    <a href={linkWith("workMode", values.workMode === "remote" ? "" : "remote")}>
                      Remote{values.workMode === "remote" && <Check />}
                    </a>
                  </Button>
                  <Button
                    asChild
                    variant={values.postedWithinDays === "7" ? "secondary" : "outline"}
                  >
                    <a
                      href={linkWith(
                        "postedWithinDays",
                        values.postedWithinDays === "7" ? "" : "7",
                      )}
                    >
                      Past week{values.postedWithinDays === "7" && <Check />}
                    </a>
                  </Button>
                  {active > 0 && (
                    <Button asChild variant="ghost" size="sm">
                      <a href={values.q ? `/?q=${encodeURIComponent(values.q)}` : "/"}>
                        Clear filters
                        <X />
                      </a>
                    </Button>
                  )}
                </>
              )}
              {values.q && !savedView && (
                <span className="text-xs text-muted-foreground">“{values.q}”</span>
              )}
            </div>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="shrink-0 bg-card" aria-label="Sort jobs on this page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  <SelectItem value="newest">Newest first</SelectItem>
                  <SelectItem value="salary">Highest salary</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="jobs-and-detail">
            <section
              className="job-results"
              aria-label={savedView ? "Saved jobs" : "Search results"}
            >
              <ul className="grid gap-2.5">
                {shownJobs.map((job, index) => (
                  <motion.li
                    key={job.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.16, delay: Math.min(index * 0.02, 0.12) }}
                  >
                    <Card
                      size="sm"
                      className={`result-card ${selected?.id === job.id ? "result-selected" : ""}`}
                    >
                      <CardContent className="grid gap-2.5">
                        <div className="flex items-center gap-2">
                          <span className="company-avatar" aria-hidden="true">
                            {job.company.slice(0, 1)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs font-medium">
                            {job.company}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {ago(job.postedAt ?? job.sortAt)}
                          </span>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            className="save-job"
                            onClick={() => toggleSave(job)}
                            aria-label={
                              saved.some((item) => item.id === job.id)
                                ? `Unsave ${job.title}`
                                : `Save ${job.title}`
                            }
                            aria-pressed={saved.some((item) => item.id === job.id)}
                          >
                            <Bookmark
                              fill={
                                saved.some((item) => item.id === job.id) ? "currentColor" : "none"
                              }
                            />
                          </Button>
                        </div>
                        <a
                          href={`/jobs/${job.id}`}
                          className="result-title"
                          aria-current={selected?.id === job.id ? "true" : undefined}
                          onClick={(event) => {
                            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                              return;
                            event.preventDefault();
                            lastOpened.current = event.currentTarget;
                            setSelected(job);
                            if (compact) setMobileDetail(true);
                          }}
                        >
                          <h2>{job.title}</h2>
                        </a>
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <MapPin className="size-3.5" />
                          {job.locationText ?? "Location not listed"}
                        </p>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap gap-1.5">
                            {job.workMode && (
                              <Badge variant="secondary" className="capitalize">
                                {job.workMode === "onsite" ? "On-site" : job.workMode}
                              </Badge>
                            )}
                            {job.employmentType && (
                              <Badge variant="outline">
                                {job.employmentType.replaceAll("_", " ")}
                              </Badge>
                            )}
                          </div>
                          <span className="text-xs font-medium tabular-nums">
                            {salary(job) ?? "Salary not listed"}
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.li>
                ))}
              </ul>
              {!shownJobs.length && (
                <Card>
                  <CardContent className="grid justify-items-start gap-3 py-4">
                    <h2 className="text-base font-medium">
                      {savedView ? "No saved jobs" : "No matching jobs"}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {savedView
                        ? "Use the bookmark button to save jobs here."
                        : "Try a different search or remove some filters."}
                    </p>
                    <Button asChild variant="outline">
                      <a href="/">
                        {savedView ? "Browse jobs" : "Clear search"}
                        <ArrowRight />
                      </a>
                    </Button>
                  </CardContent>
                </Card>
              )}
              {nextCursor && !savedView && (
                <Button asChild variant="outline" className="mt-3 w-full">
                  <a href={`/?${next}`}>
                    Next page
                    <ArrowRight />
                  </a>
                </Button>
              )}
            </section>
            <Card className="desktop-detail gap-0 py-0" ref={detailPane} aria-label="Job details">
              <div className="flex min-h-11 items-center justify-between border-b px-5">
                <span className="text-xs font-medium text-muted-foreground">Job details</span>
                {selected && (
                  <Button asChild variant="ghost" size="sm">
                    <a href={`/jobs/${selected.id}`}>
                      Open page
                      <ArrowUpRight />
                    </a>
                  </Button>
                )}
              </div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={selected?.id ?? "empty"}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                >
                  {detailContent ?? (
                    <p className="p-6 text-sm text-muted-foreground">
                      Select a job to view its description.
                    </p>
                  )}
                </motion.div>
              </AnimatePresence>
            </Card>
          </div>
        </div>
      </div>
      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent
          side="left"
          className="overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            filtersTrigger.current?.focus();
          }}
        >
          <SheetHeader>
            <SheetTitle>Filters</SheetTitle>
            <SheetDescription className="sr-only">
              Filter jobs by work arrangement, posting date, salary, and experience.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <JobFilters values={values} />
          </div>
        </SheetContent>
      </Sheet>
      <Sheet open={mobileDetail} onOpenChange={setMobileDetail}>
        <SheetContent
          className="mobile-role-sheet overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            lastOpened.current?.focus();
          }}
        >
          <SheetHeader className="border-b">
            <SheetTitle>Job details</SheetTitle>
            <SheetDescription className="sr-only">
              {selected?.title} at {selected?.company}
            </SheetDescription>
          </SheetHeader>
          {detailContent}
        </SheetContent>
      </Sheet>
      <div className="toast-region" role="status" aria-live="polite">
        <AnimatePresence>
          {notice && (
            <motion.div
              className="save-toast"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <CheckIcon size={18} color="currentColor" duration={0.5} />
              {notice}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
