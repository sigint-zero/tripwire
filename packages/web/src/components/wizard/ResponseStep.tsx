import type { EngineInfo, OnTrip, Severity } from "@tripwire/shared";
import type { WriteFunction } from "../../lib/abi";

export const severities: {
  severity: Severity;
  title: string;
  body: string;
  dot: string;
}[] = [
  {
    severity: "critical",
    title: "Critical",
    body: "Loss of funds or control.",
    dot: "bg-red-500",
  },
  {
    severity: "warning",
    title: "Warning",
    body: "A condition that comes before a loss.",
    dot: "bg-amber-400",
  },
  {
    severity: "info",
    title: "Info",
    body: "Hygiene worth knowing about.",
    dot: "bg-gray-500",
  },
];

export const actions: {
  action: OnTrip["action"];
  title: string;
  body: string;
  dot: string;
}[] = [
  {
    action: "notify",
    title: "Notify only",
    body: "Record the violation and alert your channels. Nothing happens on-chain.",
    dot: "bg-emerald-500",
  },
  {
    action: "trip_global",
    title: "Pause the contract",
    body: "Pause the whole contract through its circuit breaker.",
    dot: "bg-red-500",
  },
  {
    action: "trip_function",
    title: "Pause one function",
    body: "Pause just the function you choose; the rest keeps working.",
    dot: "bg-amber-400",
  },
];

/** How this installation carries out a pause; set for all rules in Settings. */
export const responseModes: Record<EngineInfo["responseMode"], string> = {
  prepare: "This installation holds pauses for your approval in Responses.",
  send: "This installation sends pauses at once, without waiting for approval.",
  notify:
    "On-chain response is off for this installation, so pauses are not sent.",
};

export const cooldowns = [
  { seconds: 0, label: "None" },
  { seconds: 60, label: "1 minute" },
  { seconds: 300, label: "5 minutes" },
  { seconds: 3_600, label: "1 hour" },
];

const heading =
  "mb-3 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";
const choice = (active: boolean) =>
  `inline-flex items-center gap-2 px-4 py-2 text-xs font-bold tracking-wider uppercase transition-colors ${
    active
      ? "bg-emerald-500/10 text-emerald-400"
      : "bg-white/3 text-gray-500 hover:bg-white/5 hover:text-emerald-400"
  }`;

export function ResponseStep({
  severity,
  onSeverity,
  value,
  onChange,
  writes,
  responseMode,
}: {
  severity: Severity;
  onSeverity: (severity: Severity) => void;
  value: OnTrip;
  onChange: (onTrip: OnTrip) => void;
  writes: WriteFunction[];
  responseMode: EngineInfo["responseMode"] | undefined;
}) {
  const cooldown = value.cooldown_seconds ?? 0;
  const choose = (action: OnTrip["action"]) => {
    if (action === "trip_function") {
      const first = writes[0];
      if (first) {
        onChange({
          action,
          function: first.signature,
          cooldown_seconds: cooldown,
        });
      }
    } else {
      onChange({ action, cooldown_seconds: cooldown });
    }
  };

  return (
    <div className="space-y-8">
      <section>
        <h3 className={heading}>Severity</h3>
        <div className="flex flex-wrap gap-2">
          {severities.map((s) => (
            <button
              key={s.severity}
              type="button"
              aria-pressed={severity === s.severity}
              className={choice(severity === s.severity)}
              onClick={() => onSeverity(s.severity)}
            >
              <span className={`size-1.5 ${s.dot}`} />
              {s.title}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-500">
          {severities.find((s) => s.severity === severity)?.body}
        </p>
      </section>

      <section>
        <h3 className={heading}>Action</h3>
        <div className="grid gap-3">
          {actions.map((a) => {
            const active = value.action === a.action;
            const unavailable =
              a.action === "trip_function" && writes.length === 0;
            return (
              <button
                key={a.action}
                type="button"
                aria-pressed={active}
                disabled={unavailable}
                onClick={() => choose(a.action)}
                className={`relative p-5 text-left transition-colors disabled:opacity-30 ${
                  active ? "bg-emerald-500/10" : "bg-white/3 hover:bg-white/5"
                }`}
              >
                <span className="mb-2 flex items-center gap-2 text-sm font-bold tracking-wider text-white uppercase">
                  <span className={`size-2 ${a.dot}`} />
                  {a.title}
                </span>
                <span className="text-xs leading-relaxed text-gray-500">
                  {unavailable
                    ? "This contract has no functions a rule can pause."
                    : a.body}
                </span>
              </button>
            );
          })}
        </div>
        {value.action === "trip_function" && (
          <select
            aria-label="Function to pause"
            className="mt-3 w-full bg-white/4 px-3 py-2.5 font-mono text-xs text-white transition-colors hover:bg-white/6 focus:bg-white/6"
            value={value.function}
            onChange={(e) => onChange({ ...value, function: e.target.value })}
          >
            {writes.map((w) => (
              <option key={w.signature} value={w.signature}>
                {w.signature}
              </option>
            ))}
          </select>
        )}
        {value.action !== "notify" && responseMode && (
          <p className="mt-3 text-xs text-gray-500">
            {responseModes[responseMode]} It is set for every rule in Settings.
          </p>
        )}
      </section>

      <section>
        <h3 className={heading}>Quiet period after it trips</h3>
        <div className="flex flex-wrap gap-2">
          {cooldowns.map((c) => (
            <button
              key={c.seconds}
              type="button"
              aria-pressed={cooldown === c.seconds}
              className={choice(cooldown === c.seconds)}
              onClick={() =>
                onChange({ ...value, cooldown_seconds: c.seconds })
              }
            >
              {c.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
