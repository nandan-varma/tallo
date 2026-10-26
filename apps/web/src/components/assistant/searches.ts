import type { SavedSearch, SearchSpec } from "@tallo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { requestJson } from "@/lib/client";
import { specName } from "@/lib/searches";

const SEARCHES = ["searches"];

/**
 * The searches the person keeps. The server counts what is new in each since it was last run; opening one
 * ("run") marks it seen. A change shows at once and is rolled back if the server refuses it.
 */
export function useSearches() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: SEARCHES,
    staleTime: 30_000,
    queryFn: ({ signal }) => requestJson<SavedSearch[]>("/api/searches", { signal }),
  });
  const refresh = () => client.invalidateQueries({ queryKey: SEARCHES });

  const save = useMutation({
    mutationFn: (spec: SearchSpec) =>
      requestJson<SavedSearch>("/api/searches", {
        method: "POST",
        body: { name: specName(spec), spec },
      }),
    onSettled: refresh,
  });

  const seen = useMutation({
    mutationFn: (id: number) =>
      requestJson<SavedSearch>(`/api/searches/${id}/seen`, { method: "POST" }),
    onMutate: (id) => {
      client.setQueryData<SavedSearch[]>(SEARCHES, (rows) =>
        rows?.map((row) => (row.id === id ? { ...row, newCount: 0, newCapped: false } : row)),
      );
    },
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: number) => requestJson<null>(`/api/searches/${id}`, { method: "DELETE" }),
    onMutate: (id) => {
      const before = client.getQueryData<SavedSearch[]>(SEARCHES);
      client.setQueryData<SavedSearch[]>(SEARCHES, (rows) => rows?.filter((row) => row.id !== id));
      return { before };
    },
    onError: (_error, _id, context) => client.setQueryData(SEARCHES, context?.before),
    onSettled: refresh,
  });

  return {
    searches: query.data ?? [],
    save: (spec: SearchSpec) => save.mutate(spec),
    markSeen: (id: number) => seen.mutate(id),
    remove: (id: number) => remove.mutate(id),
    saveError: save.error?.message ?? null,
  };
}
