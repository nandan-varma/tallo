import type { JobDetail, SearchSpec } from "@tallo/contracts";
import type { JobHit } from "@tallo/search-ai";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

export const PAGE_SIZE = 20;

export type SearchPage = { hits: JobHit[]; nextCursor: string | null };

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return (await response.json()) as T;
}

/**
 * One page of the database's answer to the assistant's search. The previous page stays on screen while the
 * next one loads, so the list never blanks between searches or pages.
 */
export function useSearchPage(spec: SearchSpec | null, cursor: string | undefined) {
  return useQuery({
    queryKey: ["search", spec, cursor],
    enabled: spec !== null,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      request<SearchPage>("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...spec, cursor, limit: PAGE_SIZE }),
        signal,
      }),
  });
}

/** One posting. A posting only changes when its source does, so it is kept for the visit. */
export function useJob(id: string | null) {
  return useQuery({
    queryKey: ["job", id],
    enabled: id !== null,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) => request<JobDetail>(`/api/jobs/${id}.json`, { signal }),
  });
}
