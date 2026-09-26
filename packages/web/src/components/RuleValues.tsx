import type { SavedRule, Violation } from "@tripwire/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatBig, showValue, timeAgo } from "../lib/format";
import { Chart } from "./Chart";
import { Evidence } from "./Evidence";
import { Button } from "./ui";

const heading =
  "mb-4 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";

/** What a rule reads now, its values over time, and a check at the head. */
export function RuleValues({
  rule,
  violations,
}: {
  rule: SavedRule;
  violations?: Violation[];
}) {
  const { data: series } = useQuery({
    queryKey: ["rule-series", rule.id],
    queryFn: ({ signal }) => api.ruleSeries(rule.id, signal),
  });
  const { data: current } = useQuery({
    queryKey: ["rule-current", rule.id],
    queryFn: ({ signal }) => api.ruleCurrent(rule.id, signal),
    refetchInterval: 30_000,
  });
  const check = useMutation({ mutationFn: () => api.checkNow(rule.id) });
  const result = check.data;

  return (
    <>
      <section className="mb-12">
        <h2 className={heading}>Now</h2>
        {series?.length === 0 && (
          <p className="bg-white/3 px-5 py-4 text-sm text-gray-500">
            The engine records no values for this rule's reads yet, so there is
            nothing to chart. Its evidence still shows what it saw.
          </p>
        )}
        {series && series.length > 0 && (
          <ul className="mb-6 grid gap-2 sm:grid-cols-2">
            {series.map((s) => {
              const value = current?.find((c) => c.seriesId === s.id);
              return (
                <li key={s.id} className="bg-white/3 px-5 py-4">
                  <p className="truncate font-mono text-xs text-gray-500">
                    {s.metric ? `${s.metric} of ` : ""}
                    {s.call.function.replace(/ returns \(.*\)$/, "")}
                  </p>
                  <p className="mt-1 font-mono text-lg text-white tabular-nums">
                    {value ? showValue(value.value, rule.display) : "–"}
                  </p>
                  {value && (
                    <p
                      className="mt-1 text-xs text-gray-500"
                      title={new Date(value.blockTime).toLocaleString()}
                    >
                      Block {formatBig(String(value.blockNumber))} ·{" "}
                      {timeAgo(value.blockTime)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {series && series.length > 0 && (
          <Chart rule={rule} series={series} violations={violations} />
        )}
      </section>

      <section className="mb-12">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <h2 className={`${heading} mb-0`}>Check now</h2>
          <Button
            variant="ghost"
            disabled={check.isPending}
            onClick={() => check.mutate()}
            title="Evaluates the rule once at the current block and records nothing, even while it is off"
          >
            {check.isPending
              ? "Checking…"
              : result
                ? "Check again"
                : "Check now"}
          </Button>
        </div>
        {check.error && (
          <p className="text-sm text-red-400">{check.error.message}</p>
        )}
        {result && (
          <div className="bg-black/30 px-4 py-3">
            <p className="mb-2 flex flex-wrap items-center gap-3 text-sm">
              <span
                className={
                  result.wouldTripNow ? "text-red-400" : "text-emerald-400"
                }
              >
                {result.wouldTripNow ? "Would trip now" : "Holds now"}
              </span>
              {result.block !== null && (
                <span className="font-mono text-xs text-gray-500">
                  at block {formatBig(String(result.block))}
                </span>
              )}
              {result.warming && (
                <span className="text-xs text-amber-400/80">
                  Warming up
                  {result.warmupSecondsLeft > 0 &&
                    `, about ${Math.ceil(result.warmupSecondsLeft / 60)} min left`}
                </span>
              )}
            </p>
            <Evidence evidence={result.evidence} display={rule.display} />
          </div>
        )}
      </section>
    </>
  );
}
