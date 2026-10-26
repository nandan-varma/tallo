import type {
  Application,
  ApplicationStatus,
  JobDetail,
  ProfileRecord,
  ResumeSummary,
  SearchSpec,
} from "@tallo/contracts";
import type { JobHit } from "@tallo/search-ai";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export interface Trackable {
  id: number;
  title: string;
  company: string;
  locationText: string | null;
  applyUrl: string | null;
  url: string | null;
}

const APPLICATIONS = ["applications"];

/**
 * The tracker: every role the person saved or applied to. Changes show at once and are rolled back if the
 * server refuses them, so a status never looks set when it is not.
 */
export function useTracker() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: APPLICATIONS,
    staleTime: 30_000,
    queryFn: ({ signal }) => requestJson<Application[]>("/api/applications", { signal }),
  });
  const applications = query.data ?? [];

  const change = useMutation({
    mutationFn: ({
      job,
      status,
      note,
    }: {
      job: Trackable;
      status: ApplicationStatus;
      note?: string;
    }) =>
      requestJson<Application>(`/api/applications/${job.id}`, {
        method: "PUT",
        body: { status, note },
      }),
    onMutate: async ({ job, status, note }) => {
      await client.cancelQueries({ queryKey: APPLICATIONS });
      const before = client.getQueryData<Application[]>(APPLICATIONS) ?? [];
      const now = Math.floor(Date.now() / 1000);
      const existing = before.find((application) => application.jobId === job.id);
      const next: Application = {
        jobId: job.id,
        status,
        note: note ?? existing?.note ?? "",
        title: job.title,
        company: job.company,
        location: job.locationText,
        applyUrl: job.applyUrl ?? job.url,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        appliedAt: existing?.appliedAt ?? (status === "applied" ? now : null),
      };
      client.setQueryData<Application[]>(APPLICATIONS, [
        next,
        ...before.filter((application) => application.jobId !== job.id),
      ]);
      return { before };
    },
    onError: (_error, _vars, context) => client.setQueryData(APPLICATIONS, context?.before),
    onSettled: () => client.invalidateQueries({ queryKey: APPLICATIONS }),
  });

  const remove = useMutation({
    mutationFn: (jobId: number) =>
      requestJson<null>(`/api/applications/${jobId}`, { method: "DELETE" }),
    onMutate: async (jobId) => {
      await client.cancelQueries({ queryKey: APPLICATIONS });
      const before = client.getQueryData<Application[]>(APPLICATIONS) ?? [];
      client.setQueryData<Application[]>(
        APPLICATIONS,
        before.filter((application) => application.jobId !== jobId),
      );
      return { before };
    },
    onError: (_error, _vars, context) => client.setQueryData(APPLICATIONS, context?.before),
    onSettled: () => client.invalidateQueries({ queryKey: APPLICATIONS }),
  });

  return {
    applications,
    loading: query.isPending,
    failed: change.isError || remove.isError,
    of: (jobId: number) => applications.find((application) => application.jobId === jobId),
    set: (job: Trackable, status: ApplicationStatus, note?: string) =>
      change.mutate({ job, status, note }),
    remove: (jobId: number) => remove.mutate(jobId),
  };
}
