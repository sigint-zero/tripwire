import {
  formatNumber,
  type Contract,
  type RuleDisplay,
  type SavedRule,
  type Violation,
} from "@tripwire/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../lib/api";
import { shortAddress, timeAgo } from "../lib/format";
import { responseStatuses } from "../lib/responses";
import { Evidence } from "./Evidence";
import { Button, Tag } from "./ui";
import { actions, SeverityIcon } from "./wizard/ResponseStep";

/**
 * One rule's violations at consecutive blocks, newest first. A rule
 * records one on every block while its condition holds, so a run is one
 * event to a person.
 */
interface Run {
  newest: Violation;
  oldest: Violation;
  ids: string[];
  /** The newest response any violation in the run produced. */
  response: Violation["response"];
}

function runsOf(violations: Violation[]): Run[] {
  const runs: Run[] = [];
  const growing = new Map<string, Run>();
  for (const v of violations) {
    const key = `${v.ruleId}:${v.kind}:${v.acknowledged ? "seen" : "open"}`;
    const run = growing.get(key);
    if (run && run.oldest.blockNumber - v.blockNumber <= 1) {
      run.oldest = v;
      run.ids.push(v.id);
      run.response ??= v.response;
    } else {
      const started = {
        newest: v,
        oldest: v,
        ids: [v.id],
        response: v.response,
      };
      runs.push(started);
      growing.set(key, started);
    }
  }
  return runs;
}

const kinds: Record<Violation["kind"], { label: string; tone: string }> = {
  tripped: { label: "Tripped", tone: "text-gray-400" },
  evaluation_error: { label: "Error", tone: "text-amber-400" },
  pending: { label: "Pending", tone: "text-sky-400" },
};

/** Violations as runs: what tripped, where, when, and what the engine saw. */
export function ViolationList({
  violations,
  contracts,
  rules,
  showRule = true,
  limit,
}: {
  violations: Violation[];
  /** Shows only the newest runs. */
  limit?: number;
  /** For each rule's display settings. */
  rules?: SavedRule[];
  /** Names each run's contract; leave out when all share one. */
  contracts?: Contract[];
  /** False on a rule's own page, where the name is already said. */
  showRule?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="space-y-2">
      {runsOf(violations)
        .slice(0, limit)
        // New blocks extend a run at its newest end; its oldest stays put.
        .map((run) => {
          const rule = rules?.find((r) => r.id === run.newest.ruleId);
          return (
            <RunRow
              key={run.oldest.id}
              run={run}
              contract={contracts?.find(
                (c) => c.address === run.newest.contractAddress,
              )}
              showContract={contracts !== undefined}
              display={rule?.display}
              action={
                actions.find((a) => a.action === rule?.rule.on_trip.action)
                  ?.title
              }
              showRule={showRule}
              expanded={open === run.oldest.id}
              onToggle={() =>
                setOpen((id) => (id === run.oldest.id ? null : run.oldest.id))
              }
            />
          );
        })}
    </ul>
  );
}

function RunRow({
  run,
  contract,
  showContract,
  showRule,
  display,
  action,
  expanded,
  onToggle,
}: {
  run: Run;
  contract?: Contract;
  display?: RuleDisplay;
  /** The rule's on-chain action, in words. */
  action?: string;
  showContract: boolean;
  showRule: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { newest, oldest } = run;
  const count = run.ids.length;
  const kind = kinds[newest.kind];
  const acknowledged = newest.acknowledged;
  const blocks =
    count === 1
      ? formatNumber(String(newest.blockNumber))
      : `${formatNumber(String(oldest.blockNumber))} – ${formatNumber(String(newest.blockNumber))}`;

  return (
    <li className={acknowledged ? "bg-white/2" : "bg-white/3"}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full cursor-pointer items-center gap-x-6 gap-y-1 px-5 py-4 text-left transition-colors hover:bg-white/2 md:grid-cols-[minmax(0,1fr)_auto_auto]"
      >
        <span className="flex min-w-0 items-center gap-3">
          <SeverityIcon severity={newest.severity} />
          <span
            className={`truncate text-sm font-bold tracking-wider uppercase ${acknowledged ? "text-gray-500" : "text-white"}`}
          >
            {showRule
              ? newest.ruleName
              : count === 1
                ? kind.label
                : `${kind.label} ${count} blocks`}
          </span>
          {showRule && count > 1 && (
            <span className="shrink-0 font-mono text-xs text-gray-500 tabular-nums">
              ×{count}
            </span>
          )}
          {newest.kind !== "tripped" && showRule && (
            <Tag tone={kind.tone}>{kind.label}</Tag>
          )}
          {acknowledged && <Tag>Acknowledged</Tag>}
        </span>
        <span className="flex items-center gap-4 text-xs text-gray-500">
          {showContract && (
            <span className="font-mono">
              {contract?.name ?? shortAddress(newest.contractAddress)}
            </span>
          )}
          <span
            className="font-mono tabular-nums"
            title={count > 1 ? `${count} blocks` : "Block"}
          >
            {blocks}
          </span>
        </span>
        <span
          className="text-xs text-gray-500 tabular-nums md:w-20 md:text-right"
          title={new Date(newest.blockTime).toLocaleString()}
        >
          {timeAgo(newest.blockTime)}
        </span>
      </button>

      {expanded && (
        <RunDetail
          run={run}
          showRule={showRule}
          display={display}
          action={action}
        />
      )}
    </li>
  );
}

function RunDetail({
  run,
  showRule,
  display,
  action,
}: {
  run: Run;
  showRule: boolean;
  display?: RuleDisplay;
  action?: string;
}) {
  const { newest } = run;
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const acknowledge = useMutation({
    mutationFn: () => api.acknowledge(run.ids, note),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["violations"] }),
  });
  const count = run.ids.length;

  return (
    <div className="space-y-5 px-5 pt-1 pb-5">
      <div className="bg-black/30 px-4 py-3">
        <p className="mb-2 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
          {count > 1 ? "At the latest block" : "What the engine saw"}
        </p>
        <Evidence evidence={newest.evidence} display={display} />
      </div>

      {/* Nothing is said when there was no response: under notify, a
          quiet period or a live response, none is expected. */}
      {run.response && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
          <span className="text-[10px] font-bold tracking-[0.2em] uppercase">
            Response
          </span>
          {action && <span className="text-gray-300">{action}</span>}
          <span className={responseStatuses[run.response.status].tone}>
            {responseStatuses[run.response.status].label}
          </span>
          <Link
            to="/responses"
            search={{ open: run.response.id }}
            className="transition-colors hover:text-emerald-400"
          >
            In Responses →
          </Link>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4">
        {showRule ? (
          <Link
            to="/rules/$id"
            params={{ id: newest.ruleId }}
            className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
          >
            Open the rule →
          </Link>
        ) : (
          <span />
        )}
        {newest.acknowledged ? (
          <p className="text-xs text-gray-500">
            Acknowledged {timeAgo(newest.acknowledged.at)}
            {newest.acknowledged.note && (
              <span className="text-gray-400">
                {" "}
                · {newest.acknowledged.note}
              </span>
            )}
          </p>
        ) : (
          <form
            className="flex flex-wrap items-center gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              acknowledge.mutate();
            }}
          >
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="Note (optional)"
              className="w-64 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:bg-white/8 focus:outline-none"
            />
            <Button type="submit" disabled={acknowledge.isPending}>
              {count > 1 ? `Acknowledge ${count}` : "Acknowledge"}
            </Button>
          </form>
        )}
      </div>
      {acknowledge.error && (
        <p className="text-sm text-red-400">{acknowledge.error.message}</p>
      )}
    </div>
  );
}
