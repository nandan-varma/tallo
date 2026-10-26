import type { JobDetail, ProfileRecord, ResumeSummary, SearchSpec } from "@tallo/contracts";
import type { JobHit } from "@tallo/search-ai";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { requestJson } from "@/lib/client";

export const PAGE_SIZE = 20;

export type SearchPage = { hits: JobHit[]; nextCursor: string | null };

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
      requestJson<SearchPage>("/api/search", {
        method: "POST",
        body: { ...spec, cursor, limit: PAGE_SIZE },
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
    queryFn: ({ signal }) => requestJson<JobDetail>(`/api/jobs/${id}.json`, { signal }),
  });
}

/** The resumes that exist: the base one and the copy made for each posting. */
export function useResumeCopies() {
  return useQuery({
    queryKey: ["resumes"],
    staleTime: 30_000,
    queryFn: ({ signal }) => requestJson<ResumeSummary[]>("/api/resumes", { signal }),
  });
}

/** What the person told the assistant about themselves. Fetched when the sheet opens. */
export function useAbout(enabled: boolean) {
  return useQuery({
    queryKey: ["about"],
    enabled,
    staleTime: 0,
    queryFn: ({ signal }) => requestJson<ProfileRecord | null>("/api/profile", { signal }),
  });
}
