import type { RulePreview } from "@tripwire/shared";
import { useQueries } from "@tanstack/react-query";
import { api } from "./api";

/** The previews read takes at most this many rules. */
const BATCH = 64;

/**
 * Every listed rule's preview, in batches of 64: a fixed number of
 * requests for the list, however many rules it holds.
 */
export function usePreviews(ruleIds: string[]): Map<string, RulePreview> {
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
      placeholderData: (previous: RulePreview[] | undefined) => previous,
    })),
    combine: (results) =>
      new Map(results.flatMap((r) => r.data ?? []).map((p) => [p.ruleId, p])),
  });
}
