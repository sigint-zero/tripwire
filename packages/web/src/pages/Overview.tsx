import type {
  SavedRule,
  RulePreview as RulePreviewData,
  Violation,
} from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageHeader } from "../components/PageHeader";
import { RulePreview } from "../components/RulePreview";
import { ActionPill, RuleStatusTag } from "../components/RuleStatus";
import { TrippedNow } from "../components/TrippedNow";
import { HealthStrip } from "../components/HealthStrip";
import { SetupChecklist } from "../components/SetupChecklist";
import { EmptyState } from "../components/ui";
import { ViolationList } from "../components/ViolationList";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useNow } from "../lib/useNow";
import { usePreviews } from "../lib/usePreviews";

const heading =
  "mb-4 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";
const OPEN_LIMIT = 1000;

export function OverviewPage() {
  const { data: contracts } = useQuery({
    queryKey: ["contracts"],
    queryFn: ({ signal }) => api.contracts(signal),
  });
  const { data: rules } = useQuery({
    queryKey: ["rules"],
    queryFn: ({ signal }) => api.rules(undefined, signal),
  });
  const { data: open } = useQuery({
    queryKey: ["violations", { open: true, limit: OPEN_LIMIT }],
    queryFn: ({ signal }) =>
      api.violations({ open: true, limit: OPEN_LIMIT }, signal),
  });
  const { data: pinned } = useQuery({
    queryKey: ["pinned"],
    queryFn: ({ signal }) => api.pinnedRules(signal),
  });
  const previews = usePreviews(pinned ?? []);
  const now = useNow();
  const { data: engine } = useQuery({
    queryKey: ["engine"],
    queryFn: ({ signal }) => api.engine(signal),
    staleTime: Infinity,
  });
  const { data: responses } = useQuery({
    queryKey: ["responses", "counts"],
    queryFn: ({ signal }) => api.responseCounts(signal),
  });

  const watching = contracts?.filter((c) => c.active).length;
  const on = rules?.filter((r) => r.enabled).length;
  // A queue does not vanish because the mode changed under it.
  const approvals =
    engine?.responseMode === "prepare" || (responses?.waiting ?? 0) > 0;
  const pinnedRules = (pinned ?? [])
    .map((id) => rules?.find((r) => r.id === id))
    .filter((r): r is SavedRule => r !== undefined);

  return (
    <div>
      <PageHeader
        title="Overview"
        description="What needs attention, and what you pinned."
      />

      <HealthStrip />
      <SetupChecklist />

      <div
        className={`mb-12 grid gap-2 sm:grid-cols-3 ${approvals ? "lg:grid-cols-4" : ""}`}
      >
        <Count label="Contracts watched" to="/contracts">
          {contracts && `${watching} / ${contracts.length}`}
        </Count>
        <Count label="Rules on" to="/rules">
          {rules && `${on} / ${rules.length}`}
        </Count>
        <Count
          label="Open violations"
          to="/violations"
          alert={open !== undefined && open.length > 0}
        >
          {open &&
            (open.length === OPEN_LIMIT ? `${OPEN_LIMIT}+` : open.length)}
        </Count>
        {approvals && (
          <Count
            label="Waiting for approval"
            to="/responses"
            alert={(responses?.waiting ?? 0) > 0}
          >
            {responses?.waiting}
          </Count>
        )}
      </div>

      <TrippedNow />

      <section className="mb-12">
        <h2 className={heading}>Open violations</h2>
        {open?.length === 0 && (
          <EmptyState
            compact
            title="All clear"
            hint="Nothing has tripped that is not acknowledged."
          />
        )}
        {open && open.length > 0 && (
          <>
            <ViolationList
              violations={open}
              limit={5}
              contracts={contracts ?? []}
              rules={rules}
            />
            <Link
              to="/violations"
              className="mt-4 inline-block text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
            >
              All violations →
            </Link>
          </>
        )}
      </section>

      <section>
        <h2 className={heading}>Pinned</h2>
        {pinned && pinnedRules.length === 0 && (
          <EmptyState
            compact
            title="Nothing pinned"
            hint="Pin a rule from its page to keep it here."
          />
        )}
        {pinnedRules.length > 0 && (
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {pinnedRules.map((rule) => (
              <PinnedRule
                key={rule.id}
                rule={rule}
                preview={previews.get(rule.id)}
                now={now}
                open={open?.filter((v) => v.ruleId === rule.id) ?? []}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Count({
  label,
  to,
  alert = false,
  children,
}: {
  label: string;
  to: "/contracts" | "/rules" | "/violations" | "/responses";
  alert?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={`block px-5 py-4 transition-colors ${alert ? "bg-red-500/10 hover:bg-red-500/15" : "bg-white/3 hover:bg-white/5"}`}
    >
      <p className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
        {label}
      </p>
      <p
        className={`mt-1 font-mono text-2xl tabular-nums ${alert ? "text-red-400" : "text-white"}`}
      >
        {children ?? "–"}
      </p>
    </Link>
  );
}

function PinnedRule({
  rule,
  open,
  preview,
  now,
}: {
  rule: SavedRule;
  open: Violation[];
  preview?: RulePreviewData;
  now: number;
}) {
  const latest = open[0];
  return (
    <li>
      <Link
        to="/rules/$id"
        params={{ id: rule.id }}
        className="block h-full bg-white/3 px-5 py-4 transition-colors hover:bg-white/5"
      >
        <p className="flex flex-wrap items-center gap-2 text-sm font-bold tracking-wider text-white uppercase">
          <span
            className={`size-1.5 ${rule.enabled ? "bg-emerald-500" : "bg-gray-600"}`}
          />
          {rule.rule.name}
          <RuleStatusTag status={rule.status} open={0} pill />
          <ActionPill onTrip={rule.rule.on_trip} />
        </p>
        <p className="mt-1 line-clamp-2 font-mono text-xs text-gray-400">
          {rule.sentence}
        </p>
        <div className="mt-3">
          <RulePreview rule={rule} preview={preview} size="card" now={now} />
        </div>
        <p className="mt-3 text-xs text-gray-500">
          {latest ? (
            <span className="text-red-400">
              {open.length} open · tripped {timeAgo(latest.blockTime)}
            </span>
          ) : !rule.enabled ? (
            "Off"
          ) : rule.status === "warming" ? (
            <span className="text-amber-400/80">Warming up</span>
          ) : (
            "Holding"
          )}
        </p>
      </Link>
    </li>
  );
}
