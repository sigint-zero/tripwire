import type { Response } from "@tripwire/shared";
import type { WriteFunction } from "../../lib/abi";

export const modes: {
  mode: Response["mode"];
  title: string;
  body: string;
  dot: string;
}[] = [
  {
    mode: "alert",
    title: "Alert only",
    body: "Record the violation and notify your channels. Nothing happens on-chain.",
    dot: "bg-emerald-500",
  },
  {
    mode: "approval",
    title: "Hold for approval",
    body: "Prepare the pause and wait for you to approve it in Responses.",
    dot: "bg-amber-400",
  },
  {
    mode: "autonomous",
    title: "Autonomous",
    body: "Pause immediately, before the exploit window closes.",
    dot: "bg-red-500",
  },
];

export const cooldowns = [
  { seconds: 0, label: "None" },
  { seconds: 60, label: "1 minute" },
  { seconds: 300, label: "5 minutes" },
  { seconds: 3_600, label: "1 hour" },
];

const heading =
  "mb-3 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";
const choice = (active: boolean) =>
  `px-4 py-2 text-xs font-bold tracking-wider uppercase transition-colors ${
    active
      ? "bg-emerald-500/10 text-emerald-400"
      : "bg-white/3 text-gray-500 hover:bg-white/5 hover:text-emerald-400"
  }`;

export function ResponseStep({
  value,
  writes,
  onChange,
}: {
  value: Response;
  writes: WriteFunction[];
  onChange: (response: Response) => void;
}) {
  const scope = value.scope;
  return (
    <div className="space-y-8">
      <section>
        <h3 className={heading}>Action</h3>
        <div className="grid gap-3">
          {modes.map((m) => {
            const active = value.mode === m.mode;
            return (
              <button
                key={m.mode}
                type="button"
                aria-pressed={active}
                onClick={() => onChange({ ...value, mode: m.mode })}
                className={`relative p-5 text-left transition-colors ${
                  active ? "bg-emerald-500/10" : "bg-white/3 hover:bg-white/5"
                }`}
              >
                <span className="mb-2 flex items-center gap-2 text-sm font-bold tracking-wider text-white uppercase">
                  <span className={`size-2 ${m.dot}`} />
                  {m.title}
                </span>
                <span className="text-xs leading-relaxed text-gray-500">
                  {m.body}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {value.mode !== "alert" && (
        <section>
          <h3 className={heading}>What to pause</h3>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={choice(scope.type === "contract")}
              onClick={() =>
                onChange({ ...value, scope: { type: "contract" } })
              }
            >
              Whole contract
            </button>
            <button
              type="button"
              disabled={writes.length === 0}
              className={`${choice(scope.type === "function")} disabled:opacity-30`}
              onClick={() => {
                const first = writes[0];
                if (first) {
                  onChange({
                    ...value,
                    scope: {
                      type: "function",
                      selector: first.selector,
                      signature: first.signature,
                    },
                  });
                }
              }}
            >
              One function
            </button>
            {scope.type === "function" && (
              <select
                aria-label="Function to pause"
                className="bg-white/4 px-3 py-2 font-mono text-xs text-white transition-colors hover:bg-white/6 focus:bg-white/6"
                value={scope.signature}
                onChange={(e) => {
                  const fn = writes.find((w) => w.signature === e.target.value);
                  if (fn) {
                    onChange({
                      ...value,
                      scope: {
                        type: "function",
                        selector: fn.selector,
                        signature: fn.signature,
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
            )}
          </div>
        </section>
      )}

      <section>
        <h3 className={heading}>Quiet period after it trips</h3>
        <div className="flex flex-wrap gap-2">
          {cooldowns.map((c) => (
            <button
              key={c.seconds}
              type="button"
              className={choice(value.cooldownSecs === c.seconds)}
              onClick={() => onChange({ ...value, cooldownSecs: c.seconds })}
            >
              {c.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
