import type { Contract, SavedRule } from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api";
import { shortAddress } from "../lib/format";
import { useNow } from "../lib/useNow";
import { usePreviews } from "../lib/usePreviews";
import type { ListView } from "../lib/view";
import { RulePreview } from "./RulePreview";
import { ActionPill, RuleStatusTag } from "./RuleStatus";
import { PinIcon } from "./ui";
import { SeverityIcon, severities } from "./wizard/ResponseStep";

/**
 * Rules as rows, or as a grid of cards: name, status, the engine's sentence,
 * contract, severity, action, and the rule's preview.
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
  // Every row's preview in a fixed number of requests, however many rules.
  const previews = usePreviews(rules.map((r) => r.id));
  const now = useNow();
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
        const contract = contracts?.find(
          (c) => c.address === saved.rule.contract.toLowerCase(),
        );
        const isNew = saved.id === highlight;
        return (
          <li key={saved.id}>
            <Link
              to="/rules/$id"
              params={{ id: saved.id }}
              className={`flex h-full px-5 py-4 transition-colors ${
                cards
                  ? "flex-col gap-4"
                  : "flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-6"
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
                    pill
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
                  <ActionPill onTrip={saved.rule.on_trip} />
                </p>
              </div>
              <div
                className={
                  cards ? "mt-auto border-t border-white/5 pt-3" : undefined
                }
              >
                <RulePreview
                  rule={saved}
                  preview={previews.get(saved.id)}
                  size={cards ? "card" : "row"}
                  contractName={contracts ? contract?.name : undefined}
                  now={now}
                />
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
