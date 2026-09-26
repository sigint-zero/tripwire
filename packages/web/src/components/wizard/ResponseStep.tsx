import {
  literalProblem,
  type EngineInfo,
  type OnTrip,
  type Severity,
} from "@tripwire/shared";
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
  {
    action: "call",
    title: "Call a function",
    body: "Call one of the contract's own functions, such as an admin pause(), with fixed arguments.",
    dot: "bg-sky-400",
  },
];

/** How this installation carries out an on-chain action; set for all rules in Settings. */
export const responseModes: Record<EngineInfo["responseMode"], string> = {
  prepare:
    "This installation holds on-chain actions for your approval in Responses.",
  send: "This installation sends on-chain actions at once, without waiting for approval.",
  notify: "On-chain response is off for this installation, so nothing is sent.",
};

/** The name a call is known by: "pause" for "pause()". */
const nameOf = (signature: string) =>
  signature.slice(0, signature.indexOf("("));

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
    if (action === "call") {
      // An admin pause() is what a call is usually for.
      const fn = writes.find((w) => w.signature === "pause()") ?? writes[0];
      if (fn) {
        onChange({
          action,
          call: { function: fn.signature, args: fn.inputs.map(() => "") },
          cooldown_seconds: cooldown,
        });
      }
    } else if (action === "trip_function") {
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
              (a.action === "trip_function" || a.action === "call") &&
              writes.length === 0;
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
                    ? "This contract has no functions a rule can reach."
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
        {value.action === "call" && (
          <CallFields value={value} writes={writes} onChange={onChange} />
        )}
        {value.action !== "notify" && (
          <p className="mt-3 text-xs leading-relaxed text-gray-500">
            {value.action === "call"
              ? `Tripwire's operator key sends the call, so it must hold whatever role ${nameOf(value.call.function)}() requires.`
              : "A pause acts through the Tripwire controller, so the contract must be registered with it for response."}{" "}
            {responseMode &&
              `${responseModes[responseMode]} That is set for every rule in Settings.`}
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

const field =
  "w-full bg-white/4 px-3 py-2.5 font-mono text-xs text-white transition-colors placeholder:text-gray-600 hover:bg-white/6 focus:bg-white/6";

const placeholders: [RegExp, string][] = [
  [/^u?int/, "0"],
  [/^address$/, "0x…"],
  [/^bytes/, "0x…"],
  [/^string$/, "text"],
];

/** The function a call makes, and a fixed value for each of its arguments. */
function CallFields({
  value,
  writes,
  onChange,
}: {
  value: Extract<OnTrip, { action: "call" }>;
  writes: WriteFunction[];
  onChange: (onTrip: OnTrip) => void;
}) {
  const fn = writes.find((w) => w.signature === value.call.function);
  const setArg = (index: number, arg: string) =>
    onChange({
      ...value,
      call: {
        ...value.call,
        args: value.call.args.map((a, i) => (i === index ? arg : a)),
      },
    });

  return (
    <div className="mt-3 space-y-3">
      <select
        aria-label="Function to call"
        className={field}
        value={value.call.function}
        onChange={(e) => {
          const next = writes.find((w) => w.signature === e.target.value);
          if (next) {
            onChange({
              ...value,
              call: {
                function: next.signature,
                args: next.inputs.map(() => ""),
              },
            });
          }
        }}
      >
        {writes.map((w) => (
          <option key={w.signature} value={w.signature}>
            {w.signature}
          </option>
        ))}
      </select>
      {fn?.inputs.map((input, i) => {
        const arg = value.call.args[i] ?? "";
        const problem = arg === "" ? null : literalProblem(input.type, arg);
        const label = input.name || `argument ${i + 1}`;
        return (
          <label key={i} className="block">
            <span className="mb-1.5 flex gap-2 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
              {label}
              <span className="font-mono tracking-normal text-gray-600 normal-case">
                {input.type}
              </span>
            </span>
            {input.type === "bool" ? (
              <select
                className={field}
                value={arg}
                onChange={(e) => setArg(i, e.target.value)}
              >
                <option value="" disabled>
                  choose…
                </option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                className={field}
                value={arg}
                spellCheck={false}
                placeholder={
                  placeholders.find(([type]) => type.test(input.type))?.[1]
                }
                onChange={(e) => setArg(i, e.target.value.trim())}
              />
            )}
            {problem && (
              <span className="mt-1 block text-xs text-amber-400">
                {label} {problem}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}
