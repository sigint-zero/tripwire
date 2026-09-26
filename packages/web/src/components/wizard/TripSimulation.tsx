import { formatDuration, type EngineInfo, type Rule } from "@tripwire/shared";
import { CornerBrackets } from "../ui";
import { cooldowns } from "./ResponseStep";

type Scenario = "falls" | "rises" | "band" | "event";

function scenarioFor(rule: Rule): Scenario {
  const trip = rule.trip_when;
  if (rule.when !== "every_block" || trip === true) return "event";
  if (trip.node === "deviation_band") return "band";
  if (trip.node === "compare" && (trip.op === "lt" || trip.op === "le")) {
    return "falls";
  }
  return "rises";
}

// Chart coordinates: a 300 × 100 box. The breach happens at BREACH; the
// actions follow it one PIN apart, then the quiet period runs to the end.
const BREACH = 165;
const PIN = 16;

// Each scenario: the value's path, its safe region, and the limit lines.
const shapes: Record<
  Exclude<Scenario, "event">,
  { path: string; safe: [number, number]; limits: number[]; breachY: number }
> = {
  falls: {
    path: "M0 22 C 50 18, 100 26, 135 32 S 160 42, 165 45 S 230 72, 300 80",
    safe: [0, 45],
    limits: [45],
    breachY: 45,
  },
  rises: {
    path: "M0 78 C 50 82, 100 74, 135 68 S 160 58, 165 55 S 230 28, 300 20",
    safe: [55, 100],
    limits: [55],
    breachY: 55,
  },
  band: {
    path: "M0 50 C 30 44, 60 56, 90 48 S 140 46, 155 38 S 162 32, 165 30 S 220 14, 300 8",
    safe: [30, 70],
    limits: [30, 70],
    breachY: 30,
  },
};

interface Step {
  title: string;
  detail: string;
  tone: "red" | "amber" | "gray";
}

function stepsFor(
  rule: Rule,
  responseMode: EngineInfo["responseMode"],
  sentence: string,
  contractName: string,
): Step[] {
  const onTrip = rule.on_trip;
  const target =
    onTrip.action === "trip_function"
      ? onTrip.function
      : `${contractName} (whole contract)`;
  const steps: Step[] = [
    {
      title: "Rule trips",
      detail: `“${sentence}” is no longer true.`,
      tone: "red",
    },
    {
      title: "Violation recorded",
      detail: "The values, block and transaction are saved as evidence.",
      tone: "gray",
    },
    {
      title: "Alert sent",
      detail: "Your alert channels are notified.",
      tone: "gray",
    },
  ];
  if (onTrip.action === "notify") return steps;
  if (onTrip.action === "call") {
    // A call names the function it calls, with its arguments.
    const { function: fn, args } = onTrip.call;
    const call = `${fn.slice(0, fn.indexOf("("))}(${args.join(", ")})`;
    steps.push(
      ...(responseMode === "prepare"
        ? ([
            {
              title: "Call prepared",
              detail: `A transaction calling ${call} is ready.`,
              tone: "amber",
            },
            {
              title: "Waiting for you",
              detail: "Approve or dismiss it in Responses.",
              tone: "amber",
            },
          ] as const)
        : responseMode === "send"
          ? ([
              {
                title: "Call sent",
                detail: `Tripwire calls ${call} without waiting.`,
                tone: "red",
              },
            ] as const)
          : ([
              {
                title: "Call skipped",
                detail: "On-chain response is off for this installation.",
                tone: "gray",
              },
            ] as const)),
    );
    return steps;
  }
  if (responseMode === "prepare") {
    steps.push(
      {
        title: "Pause prepared",
        detail: `A transaction pausing ${target} is ready.`,
        tone: "amber",
      },
      {
        title: "Waiting for you",
        detail: "Approve or dismiss it in Responses.",
        tone: "amber",
      },
    );
  } else if (responseMode === "send") {
    steps.push(
      {
        title: "Pause sent",
        detail: `Tripwire pauses ${target} without waiting.`,
        tone: "red",
      },
      { title: "Paused", detail: `${target} is paused.`, tone: "red" },
    );
  } else {
    steps.push({
      title: "Pause skipped",
      detail: "On-chain response is off for this installation.",
      tone: "gray",
    });
  }
  return steps;
}

const pinTone = {
  red: "border-red-500 text-red-400",
  amber: "border-amber-400 text-amber-400",
  gray: "border-gray-500 text-gray-400",
};
const titleTone = {
  red: "text-red-400",
  amber: "text-amber-400",
  gray: "text-gray-300",
};

/** What happens when the rule trips, for the chosen action. */
export function TripSimulation({
  rule,
  sentence,
  responseMode,
  contractName,
  valueLabel,
  limitLabel,
}: {
  rule: Rule;
  sentence: string;
  responseMode: EngineInfo["responseMode"];
  contractName: string;
  valueLabel: string;
  limitLabel: string;
}) {
  const steps = stepsFor(rule, responseMode, sentence, contractName);
  const cooldown = rule.on_trip.cooldown_seconds ?? 0;
  const quietLabel =
    cooldowns.find((c) => c.seconds === cooldown)?.label ?? `${cooldown}s`;
  const quietFrom =
    cooldown > 0 ? BREACH + (steps.length - 1) * PIN + PIN / 2 : null;

  return (
    <aside className="relative bg-white/2 p-5">
      <CornerBrackets />
      <p className="mb-1 truncate font-mono text-[10px] text-emerald-400">
        {valueLabel}
      </p>
      <Chart
        scenario={scenarioFor(rule)}
        steps={steps}
        limitLabel={limitLabel}
        quietFrom={quietFrom}
      />
      <Axis quietFrom={quietFrom} quietEnd={`+${formatDuration(cooldown)}`} />

      <ol className="mt-6 space-y-3">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <Pin index={i} tone={step.tone} />
            <span>
              <span
                className={`block text-xs font-bold tracking-wider uppercase ${titleTone[step.tone]}`}
              >
                {step.title}
              </span>
              <span className="block text-xs leading-relaxed text-gray-500">
                {step.detail}
              </span>
            </span>
          </li>
        ))}
        {quietFrom !== null && (
          <li className="flex gap-3">
            <span className="h-4 w-4 shrink-0 bg-white/10" />
            <span>
              <span className="block text-xs font-bold tracking-wider text-gray-300 uppercase">
                Quiet period
              </span>
              <span className="block text-xs leading-relaxed text-gray-500">
                It will not act again for {quietLabel}; violations are still
                recorded.
              </span>
            </span>
          </li>
        )}
      </ol>
    </aside>
  );
}

function Pin({ index, tone }: { index: number; tone: Step["tone"] }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center border bg-canvas font-mono text-[9px] leading-none ${pinTone[tone]}`}
    >
      {index + 1}
    </span>
  );
}

const pct = (x: number) => `${(x / 300) * 100}%`;

function Chart({
  scenario,
  steps,
  limitLabel,
  quietFrom,
}: {
  scenario: Scenario;
  steps: Step[];
  limitLabel: string;
  quietFrom: number | null;
}) {
  const shape = scenario === "event" ? null : shapes[scenario];
  return (
    <div className="relative h-36">
      <svg
        viewBox="0 0 300 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        aria-hidden
      >
        {quietFrom !== null && (
          <rect
            x={quietFrom}
            y={0}
            width={300 - quietFrom}
            height={100}
            className="fill-white/5"
          />
        )}
        <line
          x1={BREACH}
          x2={BREACH}
          y1={0}
          y2={100}
          className="stroke-red-500/40"
          vectorEffect="non-scaling-stroke"
        />
        {shape ? (
          <>
            <defs>
              <clipPath id={`safe-${scenario}`}>
                <rect
                  x={0}
                  y={shape.safe[0]}
                  width={300}
                  height={shape.safe[1] - shape.safe[0]}
                />
              </clipPath>
            </defs>
            {shape.limits.map((y) => (
              <line
                key={y}
                x1={0}
                x2={300}
                y1={y}
                y2={y}
                className="stroke-gray-500 [stroke-dasharray:4_4]"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path
              d={shape.path}
              className="fill-none stroke-red-500"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={shape.path}
              clipPath={`url(#safe-${scenario})`}
              className="fill-none stroke-emerald-400"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : (
          <>
            {Array.from({ length: 14 }, (_, i) => (
              <line
                key={i}
                x1={i * 12 + 6}
                x2={i * 12 + 6}
                y1={50}
                y2={58}
                className="stroke-gray-600"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <line
              x1={BREACH}
              x2={BREACH}
              y1={58}
              y2={20}
              className="stroke-red-500"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>

      {/* The limit's name sits on its line. */}
      {shape && limitLabel && (
        <span
          className="absolute right-0 max-w-[45%] -translate-y-full truncate pb-0.5 font-mono text-[10px] text-gray-400"
          style={{ top: `${shape.limits[0]}%` }}
        >
          {limitLabel}
        </span>
      )}

      {/* Where it breaks. */}
      <span
        className="absolute size-2 -translate-1/2 bg-red-500"
        style={{ left: pct(BREACH), top: `${shape ? shape.breachY : 20}%` }}
      />

      {/* The actions that follow, numbered as in the list below. */}
      {steps.map((step, i) => (
        <span
          key={step.title}
          className="absolute bottom-1 -translate-x-1/2"
          style={{ left: pct(BREACH + i * PIN) }}
        >
          <Pin index={i} tone={step.tone} />
        </span>
      ))}
    </div>
  );
}

function Axis({
  quietFrom,
  quietEnd,
}: {
  quietFrom: number | null;
  quietEnd: string;
}) {
  const ticks = [
    { x: 0, label: "−3m" },
    { x: BREACH / 3, label: "−2m" },
    { x: (BREACH * 2) / 3, label: "−1m" },
  ];
  return (
    <div className="relative mt-1 h-5 font-mono text-[10px] text-gray-600">
      {ticks.map((t) => (
        <span
          key={t.label}
          className="absolute top-1"
          style={{ left: pct(t.x) }}
        >
          {t.label}
        </span>
      ))}
      <span
        className="absolute top-1 -translate-x-1/2 text-red-400"
        style={{ left: pct(BREACH) }}
      >
        0
      </span>
      {quietFrom !== null && (
        <span className="absolute top-1 right-0 text-gray-500">{quietEnd}</span>
      )}
    </div>
  );
}
