import type { RuleSeries } from "@tripwire/shared";
import type { EngineReads, RuleSeriesRow } from "./engine/types";

// Which of the engine's series a rule draws from, as the engine links them
// in `rule_series`. A read the engine does not record has no series, and
// no chart: a missing chart is honest where a guessed one could show the
// wrong line.

function toSeries(row: RuleSeriesRow): RuleSeries {
  return {
    id: row.id,
    call: {
      address: row.address,
      function: row.function,
      args: row.args,
      returns: row.returns,
    },
    metric: row.metric,
    windowSeconds: row.window_seconds,
    role: row.role,
  };
}

/** Each series once, where the document first draws on it; reads before metric bases. */
function ordered(rows: RuleSeriesRow[]): RuleSeries[] {
  const seen = new Set<string>();
  return [...rows]
    .sort((a, b) => Number(a.role === "metric") - Number(b.role === "metric"))
    .filter((row) => !seen.has(row.id) && seen.add(row.id))
    .map(toSeries);
}

/** A rule's series, reads first, in the order the document reads them. */
export async function seriesOfRule(
  reads: EngineReads,
  ruleId: string,
): Promise<RuleSeries[]> {
  return ordered(await reads.ruleSeries([ruleId]));
}

/** Each rule's series, reads first, from one read of the links. */
export async function seriesByRule(
  reads: EngineReads,
  ruleIds: string[],
): Promise<Map<string, RuleSeries[]>> {
  const rows = await reads.ruleSeries(ruleIds);
  const by = new Map<string, RuleSeriesRow[]>();
  for (const row of rows)
    by.set(row.rule_id, [...(by.get(row.rule_id) ?? []), row]);
  return new Map([...by].map(([id, own]) => [id, ordered(own)]));
}
