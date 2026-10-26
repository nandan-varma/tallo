import type { JobDetail, JobSummary } from "@tallo/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { readSavedJobs } from "@/lib/saved-jobs";

/**
 * Keeps a scroller pinned to the bottom while content grows, unless the person scrolled up to read.
 * `dep` is whatever changes when content changes.
 */
export function useStickToBottom<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const stuck = useRef(true);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const toBottom = useCallback(() => {
    stuck.current = true;
    const el = ref.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);
  return { ref, onScroll, toBottom };
}

const SAVED_KEY = "tallo:saved-roles";

/** The summary fields saved roles keep; the description and facts stay out of localStorage. */
export function summaryOf(job: JobDetail): JobSummary {
  const {
    description: _d,
    facts: _f,
    team: _t,
    requisitionId: _r,
    expMaxYears: _e,
    ...summary
  } = job;
  return summary;
}

/** Bookmarks live in this browser only, under the key the previous version of the app used. */
export function useSavedJobs() {
  const [saved, setSaved] = useState<JobSummary[]>([]);
  const latest = useRef<JobSummary[]>([]);
  latest.current = saved;

  useEffect(() => {
    setSaved(readSavedJobs(localStorage.getItem(SAVED_KEY)));
    const onStorage = (event: StorageEvent) => {
      if (event.key === SAVED_KEY) setSaved(readSavedJobs(event.newValue));
    };
    addEventListener("storage", onStorage);
    return () => removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback((job: JobSummary) => {
    const current = latest.current;
    const next = current.some((item) => item.id === job.id)
      ? current.filter((item) => item.id !== job.id)
      : [...current, job];
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(next));
    } catch {
      // Storage full or blocked: the bookmark still shows for this visit.
    }
    setSaved(next);
  }, []);

  return { saved, isSaved: (id: number) => saved.some((job) => job.id === id), toggle };
}
