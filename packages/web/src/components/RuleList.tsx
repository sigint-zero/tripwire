import type { Contract, SavedRule } from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api";
import { shortAddress, showValue } from "../lib/format";
import type { ListView } from "../lib/view";
import { RuleStatusTag } from "./RuleStatus";
import { Sparkline } from "./Sparkline";
import { PinIcon } from "./ui";
import { actions, SeverityIcon, severities } from "./wizard/ResponseStep";

/**
 * Rules as rows, or as a grid of cards: name, the engine's sentence,
 * contract, severity, action, and the day's line of its first read.
 */
export function RuleList({
  rules,
  contracts,
  highlight,
  view = "rows",
}: {
  rules: SavedRule[];
  /** Names the contract on each row; leave out when all share one. */
  contracts?: Contract[];
  highlight?: string;
  view?: ListView;
}) {
  const cards = view === "cards";
  const { data: pinned } = useQuery({
    queryKey: ["pinned"],
    queryFn: ({ signal }) => api.pinnedRules(signal),
  });
  // Every row's line in one request, whatever the number of rules.
  const ids = rules.map((r) => r.id);
  const { data: sparklines } = useQuery({
    queryKey: ["sparklines", ids],
    queryFn: ({ signal }) => api.sparklines(ids, signal),
    enabled: ids.length > 0,
    refetchInterval: 60_000,
  });
  return (
    <ul
      className={
        cards
          ? "grid grid-cols-1 items-stretch gap-2 lg:grid-cols-2"
          : "space-y-2"
      }
    >
      {rules.map((saved) => {
        const severity = severities.find(
          (s) => s.severity === saved.rule.severity,
        );
        const action = actions.find(
          (a) => a.action === saved.rule.on_trip.action,
        );
        const contract = contracts?.find(
          (c) => c.address === saved.rule.contract.toLowerCase(),
        );
        const isNew = saved.id === highlight;
        const line = sparklines?.find((s) => s.ruleId === saved.id);
        const latest = line?.buckets.at(-1)?.last;
        return (
          <li key={saved.id}>
            <Link
              to="/rules/$id"
              params={{ id: saved.id }}
              className={`flex h-full px-5 py-4 transition-colors ${
                cards ? "flex-col gap-4" : "items-center justify-between gap-6"
              } ${
                isNew
                  ? "bg-emerald-500/10 hover:bg-emerald-500/15"
                  : "bg-white/3 hover:bg-white/5"
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-bold tracking-wider text-white uppercase">
                  <span
                    className={`size-1.5 ${saved.enabled ? "bg-emerald-500" : "bg-gray-600"}`}
                  />
                  {saved.rule.name}
                  {pinned?.includes(saved.id) && (
                    <span
                      title="Pinned to the Overview"
                      className="text-gray-400"
                    >
                      <PinIcon className="size-3" />
                    </span>
                  )}
                  {!saved.enabled && (
                    <span className="text-[10px] tracking-[0.2em] text-gray-500">
                      Off
                    </span>
                  )}
                  {typeof saved.origin === "object" && (
                    <span
                      className="text-[10px] tracking-[0.2em] text-violet-300"
                      title="Proposed by an AI agent through the MCP server"
                    >
                      Via {saved.origin.mcp}
                    </span>
                  )}
                  {saved.origin === "api" && (
                    <span
                      className="text-[10px] tracking-[0.2em] text-violet-300"
                      title="Stored by a script talking to the engine directly"
                    >
                      Via API
                    </span>
                  )}
                  {isNew && (
                    <span className="text-[10px] tracking-[0.2em] text-emerald-400">
                      New
                    </span>
                  )}
                  <RuleStatusTag
                    status={saved.status}
                    open={saved.openViolations}
                  />
                </p>
                <p
                  className={`mt-1 font-mono text-xs text-gray-400 ${cards ? "line-clamp-3" : "line-clamp-1"}`}
                >
                  {saved.sentence}
                </p>
                <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                  {contracts && (
                    <span className="font-mono">
                      {contract?.name ?? shortAddress(saved.rule.contract)}
                    </span>
                  )}
                  {severity && (
                    <span className="flex items-center gap-1.5 text-[10px] font-bold tracking-[0.2em] uppercase">
                      <SeverityIcon
                        severity={severity.severity}
                        className="size-3"
                      />
                      {severity.title}
                    </span>
                  )}
                  {action && (
                    <span className="text-[10px] font-bold tracking-[0.2em] uppercase">
                      {action.title}
                    </span>
                  )}
                </p>
              </div>
              {line && (
                <div
                  className={
                    cards
                      ? "flex items-end justify-between gap-4 border-t border-white/5 pt-3"
                      : "flex shrink-0 flex-col items-end gap-1"
                  }
                  title="The rule's first read over the last day"
                >
                  <Sparkline
                    buckets={line.buckets}
                    alert={saved.status === "tripped"}
                    className={cards ? "h-10 min-w-0 flex-1" : "h-8 w-36"}
                  />
                  {latest && (
                    <span className="font-mono text-xs text-gray-300 tabular-nums">
                      {showValue(latest, saved.display)}
                    </span>
                  )}
                </div>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
