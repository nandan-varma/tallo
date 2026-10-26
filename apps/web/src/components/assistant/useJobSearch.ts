import type { SearchSpec } from "@tallo/contracts";
import type { JobHit } from "@tallo/search-ai";
import { useCallback, useEffect, useRef, useState } from "react";

export const PAGE_SIZE = 20;

type Page = { hits: JobHit[]; next: string | null };
type Status = "loading" | "ready" | "error";

/**
 * Pages through the database's answer to a search spec, newest first. Pages already seen are kept, so Previous
 * is instant; a new spec starts again at page one. The API pages by cursor, so pages are reached in order.
 */
export function useJobSearch(spec: SearchSpec | null) {
  const key = spec ? JSON.stringify(spec) : "";
  const pages = useRef<Page[]>([]);
  const lastKey = useRef(key);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key identifies the spec; attempt re-runs for Retry
  useEffect(() => {
    if (lastKey.current !== key) {
      lastKey.current = key;
      pages.current = [];
      setPage(0);
    }
    if (!spec) return;
    if (pages.current[page]) {
      setStatus("ready");
      return;
    }
    const cursor = page === 0 ? undefined : (pages.current[page - 1]?.next ?? undefined);
    if (page > 0 && !cursor) return;

    setStatus("loading");
    const controller = new AbortController();
    fetch("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...spec, cursor, limit: PAGE_SIZE }),
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<{ hits: JobHit[]; nextCursor: string | null }>;
      })
      .then((data) => {
        pages.current[page] = { hits: data.hits, next: data.nextCursor };
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });
    return () => controller.abort();
  }, [key, page, attempt]);

  const current = pages.current[page];
  return {
    page,
    status,
    hits: current?.hits ?? [],
    hasNext: Boolean(current?.next),
    next: useCallback(() => setPage((p) => p + 1), []),
    previous: useCallback(() => setPage((p) => Math.max(0, p - 1)), []),
    retry: useCallback(() => setAttempt((n) => n + 1), []),
  };
}
