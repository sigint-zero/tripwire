import type { RulePreview as PreviewRead, SavedRule } from "@tripwire/shared";
import { timeAgo } from "../lib/format";
import {
  compact,
  previewOf,
  WINDOW_MS,
  type PreviewLine,
  type Tone,
} from "../lib/preview";

// The chart and readout standing for a rule in lists and pinned cards:
// its first read over a day, its limits drawn where the
// full chart draws them, and how close the latest value is, in colour.

const TONE: Record<Tone, { line: string; text: string; fill: string }> = {
  safe: { line: "#34d399", text: "text-emerald-400", fill: "#34d399" },
  near: { line: "#fbbf24", text: "text-amber-400", fill: "#fbbf24" },
  breached: { line: "#f87171", text: "text-red-400", fill: "#f87171" },
  none: { line: "#34d399", text: "text-gray-300", fill: "#34d399" },
};
const OFF = { line: "#6b7280", text: "text-gray-500", fill: "#6b7280" };

/** "43m", "1h 5m", "2d 3h": a length of time in seconds, short. */
function duration(seconds: number) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "24h", "3h", "40m": how far back the axis reaches. */
function shortSpan(ms: number) {
  const hours = ms / 3_600_000;
  return hours >= 1
    ? `${Math.round(hours)}h`
    : `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** Headroom as a percentage, and as a multiple once it passes 10×. */
function pct(h: number) {
  const sign = h >= 0 ? "+" : "−";
  const abs = Math.abs(h);
  if (abs >= 1000) return `${sign}>1000×`;
  if (abs >= 10) return `${sign}${Math.round(abs)}×`;
  return `${sign}${(abs * 100).toFixed(1)}%`;
}

export function RulePreview({
  rule,
  preview,
  size,
  contractName,
  now,
}: {
  rule: SavedRule;
  preview: PreviewRead | undefined;
  size: "row" | "card";
  /** Names the contract after the read, where rows mix contracts. */
  contractName?: string;
  now: number;
}) {
  const m = previewOf(rule, preview, now);
  const box = size === "row" ? "w-full md:w-[260px] shrink-0" : "w-full";
  const height = size === "row" ? "h-[72px]" : "h-24";

  if (!m.primary || m.primary.samples.length === 0) {
    const fired = preview?.lastFired;
    return (
      <div className={`${box} font-mono text-[10px] text-gray-500`}>
        {m.event ? (
          <p>
            Fires on each <span className="text-gray-300">{m.event}</span> event
            ·{" "}
            {fired ? (
              <span title={new Date(fired.blockTime).toLocaleString()}>
                last {timeAgo(fired.blockTime, now)}
              </span>
            ) : (
              "not yet"
            )}
          </p>
        ) : preview === undefined ? null : (
          <p>
            {rule.status === "warming"
              ? "Warming up: nothing recorded yet"
              : "Nothing recorded to chart"}
          </p>
        )}
      </div>
    );
  }

  const tone = rule.enabled ? TONE[m.tone] : OFF;
  // Like the full chart, the time axis starts where the series does when it
  // holds less than a day, so a new rule's line is not squeezed into the edge.
  const from = Math.max(now - WINDOW_MS, m.primary.samples[0]!.t);
  const span = Math.max(now - from, 60_000);
  const { low, high } = m.range;
  const samples = m.primary.samples;
  // The line breaks where nothing was recorded for more than three
  // buckets, and the break is squeezed to a sliver, so the stretches that
  // were recorded fill the chart instead of an empty middle.
  const gap = (3 * span) / 48;
  const runs: (typeof samples)[] = [];
  for (const sample of samples) {
    const run = runs.at(-1);
    if (run && sample.t - run.at(-1)!.t <= gap) run.push(sample);
    else runs.push([sample]);
  }
  const breaks = runs.slice(1).map((run, i) => ({
    from: runs[i]!.at(-1)!.t,
    to: run[0]!.t,
  }));
  const sliver = breaks.length ? span * 0.03 : 0;
  const hidden = breaks.reduce((sum, b) => sum + (b.to - b.from), 0);
  const shownSpan = Math.max(span - hidden + sliver * breaks.length, 1);
  /** Time to x: recorded time at full width, each break a sliver. */
  const x = (t: number) => {
    let at = t - from;
    for (const b of breaks) {
      if (t >= b.to) at -= b.to - b.from - sliver;
      else if (t > b.from)
        at -= ((t - b.from) / (b.to - b.from)) * (b.to - b.from - sliver);
    }
    return Math.min(100, Math.max(0, (at / shownSpan) * 100));
  };
  const y = (v: number) => ((high - v) / (high - low || 1)) * 100;
  const path = (pts: { t: number; v: number }[]) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.v)}`).join("");
  const lineOf = (run: typeof samples) =>
    path(run.map((s) => ({ t: s.t, v: Number(s.last) })));
  const rangeOf = (run: typeof samples) =>
    `M${run.map((s) => `${x(s.t)},${y(Number(s.max))}`).join("L")}${[...run]
      .reverse()
      .map((s) => `L${x(s.t)},${y(Number(s.min))}`)
      .join("")}Z`;
  const latest = m.primary.latest ?? {
    raw: samples.at(-1)!.last,
    v: Number(samples.at(-1)!.last),
    t: samples.at(-1)!.t,
  };

  const limits = m.lines.filter((l) => l.role === "limit");
  const edges = m.lines.filter((l) => l.role === "edge");
  const centre = m.lines.find((l) => l.role === "centre");
  // The trip side of each limit, shaded to the chart's edge.
  const zone = (l: PreviewLine) =>
    l.trips === null
      ? null
      : `${path(l.points)}L${x(l.points.at(-1)!.t)},${l.trips === "above" ? 0 : 100}L${x(l.points[0]!.t)},${l.trips === "above" ? 0 : 100}Z`;
  const above = edges.find((e) => e.trips === "above");
  const below = edges.find((e) => e.trips === "below");
  const band =
    above && below
      ? `${path(above.points)}${[...below.points]
          .reverse()
          .map((p) => `L${x(p.t)},${y(p.v)}`)
          .join("")}Z`
      : null;
  // Every limit by name once, equalities included; a band's centre is not one.
  const words = [
    ...new Set(m.lines.filter((l) => l.role !== "centre").map((l) => l.words)),
  ];
  const labelled = limits.length === 1 ? limits[0] : undefined;

  return (
    <div className={box}>
      <span className="sr-only">
        {`${m.primary.name} ${m.age !== null ? `updated ${duration(m.age)} ago` : compact(latest.raw, m.scale)}`}
        {words.length > 0 && `, trips ${words.join(" or ")}`}
        {m.headroom !== null &&
          (m.spare !== null
            ? `, ${duration(Math.abs(m.spare))} ${m.spare >= 0 ? "to spare" : "overdue"}`
            : `, ${pct(m.headroom)} from the limit`)}
        {m.tone === "near" && ", near the limit"}
        {m.tone === "breached" && ", past the limit"}.
      </span>
      <div className={`relative ${height}`} aria-hidden="true">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          className="absolute inset-0 size-full overflow-hidden"
        >
          {limits.map((l) => {
            const d = zone(l);
            return d ? (
              <path key={`zone:${l.key}`} d={d} fill="#ef4444" opacity={0.08} />
            ) : null;
          })}
          {band && <path d={band} fill="#34d399" opacity={0.1} />}
          {!band &&
            edges.map((l) => {
              const d = zone(l);
              return d ? (
                <path
                  key={`zone:${l.key}`}
                  d={d}
                  fill="#ef4444"
                  opacity={0.08}
                />
              ) : null;
            })}
          {runs.map((run, i) => (
            <path
              key={`range:${i}`}
              d={rangeOf(run)}
              fill={tone.fill}
              opacity={0.12}
            />
          ))}
          {breaks.map((b) => (
            <line
              key={b.from}
              x1={x((b.from + b.to) / 2)}
              x2={x((b.from + b.to) / 2)}
              y1={0}
              y2={100}
              stroke="#6b7280"
              strokeOpacity={0.5}
              strokeDasharray="1 2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {centre && (
            <path
              d={path(centre.points)}
              fill="none"
              stroke="#9ca3af"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {edges.map((l) => (
            <path
              key={l.key}
              d={path(l.points)}
              fill="none"
              stroke="#34d399"
              strokeOpacity={0.6}
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {limits.map((l) => (
            <path
              key={l.key}
              d={path(l.points)}
              fill="none"
              stroke="#f87171"
              strokeOpacity={0.8}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {runs.map((run, i) => (
            <path
              key={`line:${i}`}
              d={lineOf(
                i === runs.length - 1 && latest.t - run.at(-1)!.t <= gap
                  ? [...run, { ...run.at(-1)!, t: latest.t, last: latest.raw }]
                  : run,
              )}
              fill="none"
              stroke={tone.line}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        <span
          className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `${x(latest.t)}%`,
            top: `${Math.min(100, Math.max(0, y(latest.v)))}%`,
            background: tone.line,
          }}
        />
        <span className="absolute top-0 left-0 font-mono text-[9px] leading-none text-gray-600">
          {compact(high, m.scale, high - low)}
        </span>
        <span className="absolute bottom-0 left-0 font-mono text-[9px] leading-none text-gray-600">
          {compact(low, m.scale, high - low)}
        </span>
        {labelled && !m.range.off.some((o) => o.words === labelled.words) && (
          <span
            className="absolute right-0 -translate-y-full pb-0.5 font-mono text-[9px] leading-none text-red-400/80"
            style={{
              top: `${Math.min(100, Math.max(8, y(labelled.points.at(-1)!.v)))}%`,
            }}
          >
            {compact(labelled.points.at(-1)!.v, m.scale)}
          </span>
        )}
        {(["above", "below"] as const).map((at) => {
          const off = m.range.off.filter((o) => o.side === at);
          return off.length === 0 ? null : (
            <span
              key={at}
              className={`absolute right-0 font-mono text-[9px] leading-none text-red-400/80 ${at === "above" ? "top-0" : "bottom-0"}`}
            >
              {at === "above" ? "↑" : "↓"} trips{" "}
              {off.map((o) => o.words).join(" or ")}
            </span>
          );
        })}
      </div>
      <div
        aria-hidden="true"
        className="mt-0.5 flex justify-between font-mono text-[9px] text-gray-600"
      >
        <span>−{shortSpan(span)}</span>
        <span>now</span>
      </div>
      <p
        aria-hidden="true"
        className="mt-1 flex flex-wrap items-baseline gap-x-2 font-mono text-[10px] text-gray-500"
      >
        <span className="truncate">
          {m.primary.name}
          {contractName && (
            <span className="text-gray-600"> · {contractName}</span>
          )}
        </span>
        <span className={`tabular-nums ${tone.text}`}>
          {m.age !== null
            ? `updated ${duration(m.age)} ago`
            : compact(latest.raw, m.scale)}
        </span>
        {words.length > 0 && <span>· trips {words.join(" or ")}</span>}
        {m.headroom !== null && rule.enabled && (
          <span
            className={`tabular-nums ${tone.text}`}
            title="How far the latest value is from its limit"
          >
            ·{" "}
            {m.spare !== null
              ? m.spare >= 0
                ? `${duration(m.spare)} to spare`
                : `${duration(-m.spare)} overdue`
              : pct(m.headroom)}
          </span>
        )}
        {m.scale.auto && (
          <span
            className="text-gray-600"
            title="The contract's decimals(); set a number format on the rule's page to change it"
          >
            · auto, {m.scale.decimals} decimals
          </span>
        )}
      </p>
    </div>
  );
}
