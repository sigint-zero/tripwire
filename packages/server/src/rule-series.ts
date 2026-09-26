import {
  documentMetrics,
  documentReads,
  type RuleSeries,
} from "@tripwire/shared";
import type { EngineReads, RuleRow, SeriesRow } from "./engine/types";

// Which of the engine's series a rule draws from. The engine names its
// series; until a view links rules to them, a rule's series are found by
// matching what its document reads against the series' address, function,
// arguments and output, and the metrics over them by name and window. A
// read the engine does not record has no series, and no chart: a missing
// chart is honest where a guessed one could show the wrong line.

const sameArgs = (a: unknown, b: string[]) =>
  JSON.stringify(a) === JSON.stringify(b);

function match(rule: RuleRow, rows: SeriesRow[]): RuleSeries[] {
  const found: RuleSeries[] = [];
  const reading = (address: string | null | undefined) =>
    (address ?? rule.contract_address).toLowerCase();
  for (const read of documentReads(rule.document)) {
    const row = rows.find(
      (s) =>
        s.metric === null &&
        s.address.toLowerCase() === reading(read.address) &&
        s.function === read.function &&
        sameArgs(s.args, read.args) &&
        (s.returns ?? 0) === (read.returns ?? 0),
    );
    if (row) found.push(toSeries(row, "read"));
  }
  for (const metric of documentMetrics(rule.document)) {
    const of = metric.of;
    const row = rows.find(
      (s) =>
        s.metric === metric.metric &&
        (s.window_seconds ?? null) === (metric.window?.seconds ?? null) &&
        s.address.toLowerCase() === reading(of.address) &&
        s.function === of.function &&
        sameArgs(s.args, of.args) &&
        (s.returns ?? 0) === (of.returns ?? 0),
    );
    if (row && !found.some((f) => f.id === row.id)) {
      found.push(toSeries(row, "metric"));
    }
  }
  return found;
}

function toSeries(row: SeriesRow, role: RuleSeries["role"]): RuleSeries {
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
    role,
  };
}

/** The addresses a rule's document reads from. */
function addressesOf(rule: RuleRow): string[] {
  return [
    rule.contract_address,
    ...documentReads(rule.document).map((r) => r.address ?? ""),
  ].filter(Boolean);
}

/** A rule's series, reads first, in the order the document reads them. */
export async function seriesOfRule(
  reads: EngineReads,
  rule: RuleRow,
): Promise<RuleSeries[]> {
  return match(rule, await reads.series(addressesOf(rule)));
}

/** Each rule's first recorded read, from one read of the series view. */
export async function firstSeries(
  reads: EngineReads,
  rules: RuleRow[],
): Promise<Map<string, string>> {
  const rows = await reads.series([...new Set(rules.flatMap(addressesOf))]);
  const first = new Map<string, string>();
  for (const rule of rules) {
    const series = match(rule, rows).find((s) => s.role === "read");
    if (series) first.set(rule.id, series.id);
  }
  return first;
}
