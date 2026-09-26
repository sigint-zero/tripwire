import type { Contract, SavedRule } from "@tripwire/shared";
import { Link } from "@tanstack/react-router";
import { shortAddress } from "../lib/format";
import { actions, SeverityIcon, severities } from "./wizard/ResponseStep";

/** Rules as rows: name, the engine's sentence, contract, severity, action. */
export function RuleList({
  rules,
  contracts,
  highlight,
}: {
  rules: SavedRule[];
  /** Names the contract on each row; leave out when all share one. */
  contracts?: Contract[];
  highlight?: string;
}) {
  return (
    <ul className="space-y-2">
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
        return (
          <li key={saved.id}>
            <Link
              to="/rules/$id"
              params={{ id: saved.id }}
              className={`grid gap-2 px-5 py-4 transition-colors md:grid-cols-[1fr_auto] md:items-center ${
                isNew
                  ? "bg-emerald-500/10 hover:bg-emerald-500/15"
                  : "bg-white/3 hover:bg-white/5"
              }`}
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-bold tracking-wider text-white uppercase">
                  <span
                    className={`size-1.5 ${saved.enabled ? "bg-emerald-500" : "bg-gray-600"}`}
                  />
                  {saved.rule.name}
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
                  {isNew && (
                    <span className="text-[10px] tracking-[0.2em] text-emerald-400">
                      New
                    </span>
                  )}
                </p>
                <p className="mt-1 truncate font-mono text-xs text-gray-400">
                  {saved.sentence}
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs text-gray-500">
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
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
