import type { Resume, ResumeDoc, ResumeRecord } from "@tallo/contracts";
import { defaultResumeDoc } from "@tallo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf, requestJson } from "@/lib/client";

export type SaveState = "saved" | "unsaved" | "saving" | "error";

/** Typing pauses this long before the resume is written. */
export const AUTOSAVE_MS = 900;

/** The last AI change, kept until the next one so it can be reviewed or undone. */
export interface Review {
  previous: Resume;
  changes: string[];
  /** Tailoring is held to the facts already in the resume; a free-form edit is not. */
  kind: "tailor" | "edit";
}

/**
 * The resume being edited, saved as the person types. Edits are applied at once; a write follows when typing
 * pauses, one at a time, and a change that lands during a write is saved by the next one. Nothing is written
 * until the first edit, so opening the page never creates an empty resume.
 */
export function useResumeDoc({
  jobId,
  initial,
}: {
  jobId: number | null;
  initial: ResumeRecord | null;
}) {
  const [doc, setDoc] = useState<ResumeDoc>(() => initial?.doc ?? defaultResumeDoc());
  const [state, setState] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState<number | null>(initial?.updatedAt ?? null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);

  const latest = useRef(doc);
  /** Bumped by every edit; a write that finishes under an older number leaves the state unsaved. */
  const revision = useRef(0);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const url = jobId ? `/api/resume?job=${jobId}` : "/api/resume";

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (saving.current) return;
    saving.current = true;
    const sent = revision.current;
    setState("saving");
    try {
      const record = await requestJson<ResumeRecord>(url, { method: "PUT", body: latest.current });
      setSavedAt(record.updatedAt);
      setError(null);
      setState(revision.current === sent ? "saved" : "unsaved");
    } catch (e) {
      setError(messageOf(e));
      setState("error");
    } finally {
      saving.current = false;
    }
    // An edit that landed mid-write is picked up here, not lost.
    if (revision.current !== sent) timer.current = setTimeout(flush, AUTOSAVE_MS);
  }, [url]);

  const replace = useCallback(
    (next: ResumeDoc) => {
      latest.current = next;
      revision.current += 1;
      setDoc(next);
      setState("unsaved");
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, AUTOSAVE_MS);
    },
    [flush],
  );

  const edit = useCallback(
    (change: (current: ResumeDoc) => ResumeDoc) => replace(change(latest.current)),
    [replace],
  );

  /** Puts an AI result in place and keeps what it replaced, for review and undo. */
  const applyAi = useCallback(
    (resume: Resume, changes: string[], kind: Review["kind"]) => {
      setReview({ previous: latest.current.resume, changes, kind });
      replace({ ...latest.current, resume });
    },
    [replace],
  );

  const undoAi = useCallback(() => {
    setReview((current) => {
      if (current) replace({ ...latest.current, resume: current.previous });
      return null;
    });
  }, [replace]);

  // Leaving with unsaved work: write it now, and warn if the write cannot be trusted to finish.
  useEffect(() => {
    const unsaved = state === "unsaved" || state === "saving" || state === "error";
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const hide = () => {
      if (document.visibilityState === "hidden" && state === "unsaved") void flush();
    };
    addEventListener("beforeunload", warn);
    document.addEventListener("visibilitychange", hide);
    return () => {
      removeEventListener("beforeunload", warn);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [state, flush]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    doc,
    state,
    savedAt,
    error,
    review,
    dismissReview: () => setReview(null),
    edit,
    replace,
    applyAi,
    undoAi,
    retry: flush,
  };
}
