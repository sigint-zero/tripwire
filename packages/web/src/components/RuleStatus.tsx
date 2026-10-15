import type { OnTrip, RuleStatus } from "@tripwire/shared";

const words: Record<RuleStatus, { label: string; tone: string } | null> = {
  holding: null,
  off: null,
  tripped: { label: "Tripped", tone: "bg-red-500/10 text-red-400" },
  error: { label: "Error", tone: "bg-amber-400/10 text-amber-400" },
  warming: { label: "Warming up", tone: "bg-white/5 text-amber-400/80" },
};

/** Holding and off as pills too, where every status shows. */
const always: Record<"holding" | "off", { label: string; tone: string }> = {
  holding: { label: "Holding", tone: "bg-emerald-500/10 text-emerald-400" },
  off: { label: "Off", tone: "bg-white/5 text-gray-500" },
};

/** The status as the list shows it, when it shows one. */
export const statusLabel = (status: RuleStatus) => words[status]?.label ?? null;

const titles: Record<RuleStatus, string> = {
  holding: "On, and the condition does not hold",
  off: "Switched off",
  tripped: "The condition holds at the block last evaluated",
  error: "The rule could not be evaluated at the block last evaluated",
  warming:
    "A metric it reads has too little history yet; it cannot trip until it has",
};

/**
 * A rule's status in words when it is not simply holding, and the
 * violations nobody has looked at: a rule can hold now with a run open.
 */
export function RuleStatusTag({
  status,
  open,
  pill = false,
}: {
  status: RuleStatus;
  open: number;
  /** Holding and off shown as well. */
  pill?: boolean;
}) {
  const word =
    words[status] ??
    (pill && (status === "holding" || status === "off")
      ? always[status]
      : null);
  if (!word && open === 0) return null;
  return (
    <span className="inline-flex items-center gap-2 text-[10px] font-bold tracking-[0.2em] uppercase">
      {word && (
        <span className={`px-2 py-0.5 ${word.tone}`} title={titles[status]}>
          {word.label}
        </span>
      )}
      {open > 0 && (
        <span
          className="font-mono text-red-400/80 tabular-nums"
          title="Violations nobody has acknowledged"
        >
          {open} open
        </span>
      )}
    </span>
  );
}

/** What a trip does, short: Notify, Pauses contract, Pauses withdraw(uint256). */
export function ActionPill({ onTrip }: { onTrip: OnTrip }) {
  const [verb, fn] =
    onTrip.action === "notify"
      ? ["Notify", null]
      : onTrip.action === "trip_global"
        ? ["Pauses contract", null]
        : onTrip.action === "trip_function"
          ? ["Pauses", onTrip.function]
          : ["Calls", onTrip.call.function];
  return (
    <span className="inline-flex items-center gap-1.5 bg-white/5 px-2 py-0.5 text-[10px] font-bold tracking-[0.2em] text-gray-300 uppercase">
      {verb}
      {fn && (
        <code className="font-mono font-normal tracking-normal normal-case">
          {fn}
        </code>
      )}
    </span>
  );
}
