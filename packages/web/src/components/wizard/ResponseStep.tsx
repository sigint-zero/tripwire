import { Link } from "@tanstack/react-router";
import {
  literalProblem,
  type EngineInfo,
  type OnTrip,
  type Severity,
} from "@tripwire/shared";
import type { WriteFunction } from "../../lib/abi";
import { choice, track } from "../ui";

export const severities: {
  severity: Severity;
  title: string;
  body: string;
  /** The colour its icon takes. */
  tone: string;
}[] = [
  {
    severity: "critical",
    title: "Critical",
    body: "Loss of funds or control.",
    tone: "text-red-500",
  },
  {
    severity: "warning",
    title: "Warning",
    body: "A condition that comes before a loss.",
    tone: "text-amber-400",
  },
  {
    severity: "info",
    title: "Info",
    body: "Hygiene worth knowing about.",
    tone: "text-sky-400",
  },
];

/** A severity as a bell in its colour, or in the text's when `plain`. */
export function SeverityIcon({
  severity,
  className = "size-3.5",
  plain = false,
}: {
  severity: Severity;
  className?: string;
  plain?: boolean;
}) {
  const tone = plain
    ? ""
    : severities.find((s) => s.severity === severity)?.tone;
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={`shrink-0 fill-none stroke-current stroke-[1.5] ${tone} ${className}`}
    >
      <path d="M4 11.5 V7 A4 4 0 0 1 12 7 V11.5 L13.5 13 H2.5 Z" />
      <path d="M6.5 14.5 H9.5" />
    </svg>
  );
}

export const actions: {
  action: OnTrip["action"];
  title: string;
  body: string;
  /** Acts through the TripwireController, so needs the contract registered there. */
  controller?: true;
}[] = [
  {
    action: "notify",
    title: "Notify only",
    body: "Record the violation and alert. The contract is left alone.",
  },
  {
    action: "call",
    title: "Call a function",
    body: "Call one of the contract's own functions, such as its pause(), with fixed arguments.",
  },
  {
    action: "trip_global",
    title: "Pause the contract",
    body: "Pause the whole contract through the Tripwire controller.",
    controller: true,
  },
  {
    action: "trip_function",
    title: "Pause one function",
    body: "Pause just the function you choose, through the Tripwire controller.",
    controller: true,
  },
];

/** How this installation carries out an on-chain action; set for all rules in Settings. */
export const responseModes: Record<EngineInfo["responseMode"], string> = {
  prepare: "Held for your approval.",
  send: "Sent at once.",
  notify: "On-chain response is off in Settings.",
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

const row = "space-y-3";
const rowLabel =
  "text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";
/** One control per row: a single track, only the chosen option filled. */

export function ResponseStep({
  severity,
  onSeverity,
  value,
  onChange,
  writes,
  responseMode,
  contract,
  registered = false,
}: {
  severity: Severity;
  onSeverity: (severity: Severity) => void;
  value: OnTrip;
  onChange: (onTrip: OnTrip) => void;
  writes: WriteFunction[];
  responseMode: EngineInfo["responseMode"] | undefined;
  /** The rule's contract, whose page shows its response readiness. */
  contract: string;
  /** Registered with the TripwireController, which adds its two pauses. */
  registered?: boolean;
}) {
  // A rule already pausing through the controller keeps its choice in view.
  const offered = actions.filter(
    (a) =>
      !a.controller ||
      registered ||
      value.action === "trip_global" ||
      value.action === "trip_function",
  );
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
      <div className={row}>
        <h3 className={rowLabel}>On-chain</h3>
        <div>
          <div className={track}>
            {offered.map((a) => {
              const unavailable =
                (a.action === "trip_function" || a.action === "call") &&
                writes.length === 0;
              return (
                <button
                  key={a.action}
                  type="button"
                  aria-pressed={value.action === a.action}
                  disabled={unavailable}
                  title={
                    unavailable
                      ? "This contract has no functions a rule can reach."
                      : a.body
                  }
                  onClick={() => choose(a.action)}
                  className={`${choice(value.action === a.action)} disabled:opacity-30`}
                >
                  {a.title}
                </button>
              );
            })}
          </div>
          {value.action === "trip_function" && (
            <select
              aria-label="Function to pause"
              className={`mt-4 ${field}`}
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
            <p className="mt-3 text-xs text-gray-500">
              {value.action === "call"
                ? `Sent from Tripwire's key, which must be allowed to call ${nameOf(value.call.function)}().`
                : "Sent through the Tripwire controller, where Tripwire's key must be an operator."}{" "}
              {responseMode && responseModes[responseMode]}{" "}
              <Link
                to="/contracts/$address"
                params={{ address: contract }}
                className="text-emerald-400 transition-colors hover:text-emerald-300"
              >
                Readiness
              </Link>
            </p>
          )}
        </div>
      </div>

      <div className={row}>
        <h3 className={rowLabel}>Alert as</h3>
        <div className={track}>
          {severities.map((s) => (
            <button
              key={s.severity}
              type="button"
              aria-pressed={severity === s.severity}
              title={s.body}
              className={choice(severity === s.severity)}
              onClick={() => onSeverity(s.severity)}
            >
              <SeverityIcon severity={s.severity} />
              {s.title}
            </button>
          ))}
        </div>
      </div>

      <div className={row}>
        <h3 className={rowLabel}>Quiet for</h3>
        <div className={track}>
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
      </div>
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
