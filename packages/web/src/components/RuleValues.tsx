import type { CheckNow, SavedRule, Violation } from "@tripwire/shared";
import { useState } from "react";
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
  // The last result stays up while the next check runs, so nothing jumps.
  const [shown, setShown] = useState<CheckNow>();
  const check = useMutation({
    mutationFn: () => api.checkNow(rule.id),
    onSuccess: setShown,
  });

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
        <h2 className={heading}>Check now</h2>
        <div className="bg-white/3">
          <div className="flex items-center justify-between gap-6 px-5 py-4">
            <div className="min-w-0">
              <p
                className={`font-mono text-lg ${
                  !shown
                    ? "text-gray-600"
                    : shown.evaluationError
                      ? "text-amber-400"
                      : shown.wouldTripNow
                        ? "text-red-400"
                        : "text-emerald-400"
                }`}
              >
                {/* A rule that cannot be evaluated never fires: not "holds". */}
                {!shown
                  ? "–"
                  : shown.evaluationError
                    ? "Cannot be evaluated"
                    : shown.wouldTripNow
                      ? "Would trip now"
                      : "Holds now"}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                {!shown ? (
                  "Once, at the latest block. Records nothing."
                ) : (
                  <>
                    {shown.block !== null &&
                      `Block ${formatBig(String(shown.block))}`}
                    {shown.warming && (
                      <span className="text-amber-400/80">
                        {shown.block !== null && " · "}
                        Warming up
                        {shown.warmupSecondsLeft > 0 &&
                          `, about ${Math.ceil(shown.warmupSecondsLeft / 60)} min left`}
                      </span>
                    )}
                  </>
                )}
              </p>
              {check.error && (
                <p className="mt-2 text-sm text-red-400">
                  {check.error.message}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              disabled={check.isPending}
              onClick={() => check.mutate()}
              title="Evaluates the rule once at the current block and records nothing, even while it is off"
              className="shrink-0"
            >
              {/* Sized for the longest label, so the button never jumps. */}
              <span className="grid">
                <span className="invisible col-start-1 row-start-1">
                  Check again
                </span>
                <span className="col-start-1 row-start-1">
                  {check.isPending
                    ? "Checking…"
                    : shown
                      ? "Check again"
                      : "Check"}
                </span>
              </span>
            </Button>
          </div>
          {shown && (
            <div
              className={`border-t border-white/5 px-5 py-4 transition-opacity ${check.isPending ? "opacity-40" : ""}`}
            >
              {shown.evaluationError && (
                <p className="mb-3 text-sm text-amber-300">
                  {shown.evaluationError.message}
                  <span className="ml-2 font-mono text-xs text-gray-500">
                    at {shown.evaluationError.path}
                  </span>
                </p>
              )}
              <div className="max-w-3xl">
                <Evidence
                  evidence={shown.evidence}
                  display={rule.display}
                  contract={rule.rule.contract}
                />
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
