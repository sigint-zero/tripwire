import type { RuleStatus } from "@tripwire/shared";

const words: Record<RuleStatus, { label: string; tone: string } | null> = {
  holding: null,
  off: null,
  tripped: { label: "Tripped", tone: "bg-red-500/10 text-red-400" },
  error: { label: "Error", tone: "bg-amber-400/10 text-amber-400" },
  warming: { label: "Warming up", tone: "bg-white/5 text-amber-400/80" },
};

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
}: {
  status: RuleStatus;
  open: number;
}) {
  const word = words[status];
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
