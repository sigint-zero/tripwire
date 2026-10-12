import type { RulePreview } from "@tripwire/shared";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/** The previews read takes at most this many rules. */
const BATCH = 64;

/**
 * Every listed rule's preview, in batches of 64: a fixed number of
 * requests for the list, however many rules it holds.
 */
export function usePreviews(ruleIds: string[]): Map<string, RulePreview> {
  const client = useQueryClient();
  // What an earlier batch already read, shown while this one loads: a
  // search narrows the list without blanking every preview.
  const known = (ids: string[]) => {
    const all = client
      .getQueriesData<RulePreview[]>({ queryKey: ["previews"] })
      .flatMap(([, data]) => data ?? []);
    const found = ids.flatMap((id) => all.find((p) => p.ruleId === id) ?? []);
    return found.length > 0 ? found : undefined;
  };
  const batches: string[][] = [];
  for (let i = 0; i < ruleIds.length; i += BATCH) {
    batches.push(ruleIds.slice(i, i + BATCH));
  }
  return useQueries({
    queries: batches.map((ids) => ({
      queryKey: ["previews", ids],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.previews(ids, signal),
      refetchInterval: 60_000,
      placeholderData: (previous: RulePreview[] | undefined) =>
        previous ?? known(ids),
    })),
    combine: (results) =>
      new Map(results.flatMap((r) => r.data ?? []).map((p) => [p.ruleId, p])),
  });
}
