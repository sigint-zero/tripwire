import {
  formatDuration,
  type BoolNode,
  type RuleSeries,
  type SavedRule,
  type SeriesWindow,
  type ValueNode,
  type Violation,
} from "@tripwire/shared";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatBig, showValue } from "../lib/format";
import { choice, track } from "./ui";

// A rule's recorded values over a window, drawn by hand in SVG. Each
// stretch's low-to-high range sits faint behind the line through its last
// values, so a one-block spike stays visible at any zoom. Values arrive as
// exact decimal strings; they become numbers only to be placed, and every
// label shows the string.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const WINDOWS = [
  { key: "1h", title: "1h", ms: HOUR },
  { key: "24h", title: "24h", ms: DAY },
  { key: "7d", title: "7d", ms: 7 * DAY },
  { key: "30d", title: "30d", ms: 30 * DAY },
  { key: "90d", title: "90d", ms: 90 * DAY },
  { key: "all", title: "All", ms: 5 * 365 * DAY },
] as const;
type WindowKey = (typeof WINDOWS)[number]["key"];
const STORED = "tripwire.chartWindow";
const COLOURS = ["#34d399", "#38bdf8", "#a78bfa", "#fbbf24"];
const OPS: Record<string, string> = {
  lt: "<",
  le: "≤",
  gt: ">",
  ge: "≥",
  eq: "=",
  ne: "≠",
};
const FLIP: Record<string, string> = {
  lt: "gt",
  le: "ge",
  gt: "lt",
  ge: "le",
  eq: "eq",
  ne: "ne",
};

export interface Sample {
  t: number;
  last: string;
  min: string;
  max: string;
  block?: number;
  count?: number;
}

function samplesOf(window: SeriesWindow | undefined): Sample[] {
  if (!window) return [];
  if ("points" in window) {
    return window.points.map((p) => ({
      t: Date.parse(p.blockTime),
      last: p.value,
      min: p.value,
      max: p.value,
      block: p.blockNumber,
    }));
  }
  return window.buckets.map((b) => ({
    t: Date.parse(b.start),
    last: b.last,
    min: b.min,
    max: b.max,
    count: b.count,
  }));
}

const sameCall = (node: ValueNode, s: RuleSeries, contract: string) =>
  node.node === "view_call" &&
  s.role === "read" &&
  (node.address ?? contract).toLowerCase() === s.call.address.toLowerCase() &&
  node.function === s.call.function &&
  JSON.stringify(node.args) === JSON.stringify(s.call.args) &&
  (node.returns ?? 0) === (s.call.returns ?? 0);

/** Which side of a boundary trips the rule. */
type Trips = "above" | "below" | null;
const TRIPS: Record<string, Trips> = {
  lt: "below",
  le: "below",
  gt: "above",
  ge: "above",
  eq: null,
  ne: null,
};

interface Threshold {
  seriesId: string;
  value: string;
  label: string;
  trips: Trips;
}

/**
 * A limit that moves, worked out from a recorded read the way the engine
 * works it out: another read it is compared with, a band around its
 * trailing average, the most it may grow or fall within a window, or how
 * old a timestamp may get.
 */
export type Derived =
  | { kind: "read"; seriesId: string; otherId: string; op: string }
  | {
      kind: "band";
      seriesId: string;
      window: number;
      percent: number;
      sides: "both" | "above" | "below";
    }
  | { kind: "growth"; seriesId: string; window: number; fraction: number }
  | { kind: "drop"; seriesId: string; window: number; percent: number }
  | { kind: "age"; seriesId: string; seconds: number };

interface Boundary {
  key: string;
  /** `partial` where less than a whole window of history lies behind. */
  points: { t: number; v: number; partial?: boolean }[];
  trips: Trips;
  label: string;
}

interface Band {
  centerId: string;
  percent: number;
  sides: "both" | "above" | "below";
}

/** Horizontal lines where a read is compared with a literal, and bands. */
function overlaysOf(rule: SavedRule, series: RuleSeries[]) {
  const thresholds: Threshold[] = [];
  const bands: Band[] = [];
  const derived: Derived[] = [];
  const contract = rule.rule.contract;
  const readOf = (node: ValueNode) =>
    series.find((x) => sameCall(node, x, contract));

  const derive = (n: Extract<BoolNode, { node: "compare" }>) => {
    const { left, right, op } = n;
    // A read against another read: the other is the limit.
    const a = readOf(left);
    const b = readOf(right);
    if (a && b) {
      derived.push({ kind: "read", seriesId: a.id, otherId: b.id, op });
      return;
    }
    if (op !== "gt" && op !== "ge") return;
    if (left.node === "metric" && left.window) {
      const read = readOf(left.of);
      if (!read) return;
      const window = left.window.seconds;
      if (left.metric === "windowed_drop" && right.node === "literal") {
        derived.push({
          kind: "drop",
          seriesId: read.id,
          window,
          percent: Number(right.value),
        });
      }
      // The growth template: the change within the window above value × n.
      if (
        left.metric === "windowed_delta" &&
        right.node === "arithmetic" &&
        right.op === "mul" &&
        right.right.node === "literal"
      ) {
        derived.push({
          kind: "growth",
          seriesId: read.id,
          window,
          fraction: Number(right.right.value),
        });
      }
      return;
    }
    // The freshness template: now − timestamp above a number of seconds.
    if (
      left.node === "arithmetic" &&
      left.op === "sub" &&
      left.left.node === "now" &&
      right.node === "literal"
    ) {
      const read = readOf(left.right);
      if (read) {
        derived.push({
          kind: "age",
          seriesId: read.id,
          seconds: Number(right.value),
        });
      }
    }
  };

  const visit = (n: BoolNode) => {
    if (n === true) return;
    switch (n.node) {
      case "compare": {
        const sides: [ValueNode, ValueNode, string][] = [
          [n.left, n.right, n.op],
          [n.right, n.left, FLIP[n.op]!],
        ];
        for (const [read, other, op] of sides) {
          if (other.node !== "literal") continue;
          const s = series.find((x) => sameCall(read, x, contract));
          if (s) {
            thresholds.push({
              seriesId: s.id,
              value: other.value,
              label: `${OPS[op]} ${showValue(other.value, rule.display)}`,
              trips: TRIPS[op] ?? null,
            });
          }
        }
        derive(n);
        return;
      }
      case "deviation_band": {
        const center = n.center;
        if (center.node !== "metric") return;
        const s = series.find(
          (x) =>
            x.role === "metric" &&
            x.metric === center.metric &&
            (x.windowSeconds ?? null) === (center.window?.seconds ?? null),
        );
        if (s) {
          bands.push({
            centerId: s.id,
            percent: Number(n.tolerance_percent),
            sides: n.sides,
          });
        } else if (center.window) {
          // No recorded average: work it out from the read itself.
          const read = readOf(center.of);
          if (read) {
            derived.push({
              kind: "band",
              seriesId: read.id,
              window: center.window.seconds,
              percent: Number(n.tolerance_percent),
              sides: n.sides,
            });
          }
        }
        return;
      }
      case "and":
      case "or":
        n.terms.forEach(visit);
        return;
      case "not":
        visit(n.expr);
        return;
      default:
        return;
    }
  };
  visit(rule.rule.trip_when);
  return { thresholds, bands, derived };
}

/** The limit a derived boundary sets at each recorded time of its read. */
export function boundaryOf(
  d: Derived,
  samples: Sample[],
  other: Sample[],
  otherName: string,
): Boundary[] {
  // The last sample at or before t; asked in rising t, so it walks forward.
  let cursor = 0;
  const at = (t: number) => {
    while (cursor + 1 < samples.length && samples[cursor + 1]!.t <= t) {
      cursor++;
    }
    return samples[cursor];
  };
  const first = samples[0]?.t ?? 0;
  // Until a whole window lies behind it, a limit is worked out from the
  // history there is, as the engine does while it warms up.
  const partial = (t: number, w: number) => t - w * 1000 < first;
  /** Each sample's trailing window, averaged and at its highest, in one pass. */
  const trailing = (w: number) => {
    const out: { t: number; mean: number; high: number; partial: boolean }[] =
      [];
    const highs: number[] = []; // indexes, their highs falling
    let from = 0;
    let sum = 0;
    samples.forEach((s, i) => {
      sum += Number(s.last);
      while (
        highs.length &&
        Number(samples[highs[highs.length - 1]!]!.max) <= Number(s.max)
      ) {
        highs.pop();
      }
      highs.push(i);
      while (samples[from]!.t <= s.t - w * 1000) {
        sum -= Number(samples[from]!.last);
        from++;
      }
      while (highs[0]! < from) highs.shift();
      out.push({
        t: s.t,
        mean: sum / (i - from + 1),
        high: Number(samples[highs[0]!]!.max),
        partial: partial(s.t, w),
      });
    });
    return out;
  };

  switch (d.kind) {
    case "read":
      return [
        {
          key: `read:${d.otherId}`,
          points: other.map((s) => ({ t: s.t, v: Number(s.last) })),
          trips: TRIPS[d.op] ?? null,
          label: `${OPS[d.op]} ${otherName}`,
        },
      ];
    case "band": {
      const f = d.percent / 100;
      const centre = trailing(d.window).map((p) => ({
        t: p.t,
        v: p.mean,
        partial: p.partial,
      }));
      const sign = d.sides === "both" ? "±" : d.sides === "above" ? "+" : "−";
      const label = `${sign}${d.percent}% of ${formatDuration(d.window)} avg`;
      const edges: Boundary[] = [];
      if (d.sides !== "below") {
        edges.push({
          key: "band:above",
          points: centre.map((p) => ({ ...p, v: p.v * (1 + f) })),
          trips: "above",
          label,
        });
      }
      if (d.sides !== "above") {
        edges.push({
          key: "band:below",
          points: centre.map((p) => ({ ...p, v: p.v * (1 - f) })),
          trips: "below",
          label: d.sides === "both" ? "" : label,
        });
      }
      return edges;
    }
    case "growth":
      return [
        {
          key: "growth",
          points: samples.map((s) => ({
            t: s.t,
            v: Number(at(s.t - d.window * 1000)!.last) / (1 - d.fraction),
            partial: partial(s.t, d.window),
          })),
          trips: "above",
          label: `+${Math.round(d.fraction * 1000) / 10}% in ${formatDuration(d.window)}`,
        },
      ];
    case "drop":
      return [
        {
          key: "drop",
          points: trailing(d.window).map((p) => ({
            t: p.t,
            v: p.high * (1 - d.percent / 100),
            partial: p.partial,
          })),
          trips: "below",
          label: `−${d.percent}% from ${formatDuration(d.window)} high`,
        },
      ];
    case "age":
      return [
        {
          key: "age",
          points: samples.map((s) => ({ t: s.t, v: s.t / 1000 - d.seconds })),
          trips: "below",
          label: `older than ${formatDuration(d.seconds)}`,
        },
      ];
  }
}

/** A series' name in the legend: its function, and the metric over it. */
function nameOf(s: RuleSeries) {
  const fn = s.call.function.replace(/ returns \(.*\)$/, "");
  return s.metric ? `${s.metric} of ${fn}` : fn;
}

const minute = () => Math.ceil(Date.now() / 60_000) * 60_000;

/**
 * Now, a minute at a time: the window runs to now, and its edges move
 * only once a minute so the query keys stay put between refetches.
 */
function useMinute() {
  const [now, setNow] = useState(minute);
  useEffect(() => {
    const timer = setInterval(() => setNow(minute()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function storedWindow(): WindowKey {
  const saved = localStorage.getItem(STORED);
  return WINDOWS.some((w) => w.key === saved) ? (saved as WindowKey) : "24h";
}

export function Chart({
  rule,
  series,
  violations,
}: {
  rule: SavedRule;
  series: RuleSeries[];
  violations?: Violation[];
}) {
  const [windowKey, setWindowKey] = useState<WindowKey>(storedWindow);
  const span = WINDOWS.find((w) => w.key === windowKey)!.ms;
  const to = useMinute();
  const from = to - span;
  const { thresholds, bands, derived } = useMemo(
    () => overlaysOf(rule, series),
    [rule, series],
  );
  const windows = useQueries({
    queries: series.map((s) => ({
      queryKey: ["series", s.id, windowKey, to],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.seriesWindow(
          s.id,
          {
            from: new Date(from).toISOString(),
            to: new Date(to).toISOString(),
          },
          signal,
        ),
      refetchInterval: 60_000,
      placeholderData: (previous: SeriesWindow | undefined) => previous,
    })),
  });
  // A windowed limit needs the window before the first time shown.
  const reach = (id: string) =>
    Math.max(
      0,
      ...derived
        .filter((d) => d.seriesId === id && "window" in d)
        .map((d) => ("window" in d ? d.window * 1000 : 0)),
    );
  const history = useQueries({
    queries: series.map((s) => ({
      queryKey: ["series", s.id, "history", from - reach(s.id), to],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.seriesWindow(
          s.id,
          {
            from: new Date(from - reach(s.id)).toISOString(),
            to: new Date(to).toISOString(),
          },
          signal,
        ),
      enabled: reach(s.id) > 0,
      refetchInterval: 60_000,
      placeholderData: (previous: SeriesWindow | undefined) => previous,
    })),
  });
  const lines = series.map((s, i) => ({
    series: s,
    colour: COLOURS[i % COLOURS.length]!,
    samples: samplesOf(windows[i]?.data),
  }));
  // Worked out once per load, not on every hover.
  const loaded = windows
    .map((w) => w.dataUpdatedAt)
    .concat(history.map((w) => w.dataUpdatedAt))
    .join();
  const boundaries = useMemo(() => {
    const samplesById = (id: string) => {
      const i = series.findIndex((s) => s.id === id);
      return samplesOf(history[i]?.data ?? windows[i]?.data);
    };
    const shown = derived.flatMap((d) =>
      boundaryOf(
        d,
        samplesById(d.seriesId),
        d.kind === "read" ? samplesById(d.otherId) : [],
        d.kind === "read"
          ? nameOf(series.find((s) => s.id === d.otherId)!)
          : "",
      ),
    );
    return shown.map((b) => {
      const points = b.points.filter((p) => p.t >= from);
      const warming = points.some((p) => p.partial);
      return {
        ...b,
        points,
        label: b.label && warming ? `${b.label} · warming up` : b.label,
      };
    });

    // `loaded` stands in for the windows' data, which changes identity each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, series, loaded]);

  const all = lines.flatMap((l) => l.samples);
  // A window longer than the series starts where the series starts.
  const start = all.length
    ? Math.max(from, Math.min(...all.map((s) => s.t)))
    : from;
  const values = [
    ...all.flatMap((s) => [Number(s.min), Number(s.max)]),
    ...thresholds.map((t) => Number(t.value)),
    ...boundaries.flatMap((b) => b.points.map((p) => p.v)),
  ];
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  // Labels show the exact recorded strings, never a float turned back.
  const highest = all.reduce<string | null>(
    (best, s) => (best === null || Number(s.max) > Number(best) ? s.max : best),
    null,
  );
  const lowest = all.reduce<string | null>(
    (best, s) => (best === null || Number(s.min) < Number(best) ? s.min : best),
    null,
  );
  const pad = (high - low) * 0.08 || Math.abs(high) * 0.01 || 1;
  const yLow = low - pad;
  const yHigh = high + pad;

  const W = 800;
  const H = 220;
  const x = (t: number) => ((t - start) / (to - start || 1)) * W;
  const y = (v: number) => H - ((v - yLow) / (yHigh - yLow)) * H;

  /** The line, broken where points are more than three times their usual gap apart. */
  const pathOf = (samples: Sample[], pick: (s: Sample) => number) => {
    const gaps = samples.slice(1).map((s, i) => s.t - samples[i]!.t);
    const usual =
      [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
    return samples
      .map((s, i) => {
        const broken = i === 0 || (usual > 0 && gaps[i - 1]! > usual * 3);
        return `${broken ? "M" : "L"}${x(s.t).toFixed(1)},${y(pick(s)).toFixed(1)}`;
      })
      .join("");
  };
  const rangeOf = (samples: Sample[]) =>
    samples.length < 2
      ? ""
      : samples
          .map((s, i) => `${i ? "L" : "M"}${x(s.t)},${y(Number(s.max))}`)
          .join("") +
        [...samples]
          .reverse()
          .map((s) => `L${x(s.t)},${y(Number(s.min))}`)
          .join("") +
        "Z";

  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const nearest = (samples: Sample[], t: number) =>
    samples.reduce<Sample | null>(
      (best, s) =>
        !best || Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best,
      null,
    );
  const marks = (violations ?? []).filter((v) => {
    const t = Date.parse(v.blockTime);
    return t >= start && t <= to;
  });
  const loading = windows.some((w) => w.isPending);
  const resolution = windows.find((w) => w.data)?.data?.resolution;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4 text-xs text-gray-400">
          {lines.map((l) => (
            <span key={l.series.id} className="flex items-center gap-2">
              <span className="h-0.5 w-4" style={{ background: l.colour }} />
              <code className="font-mono">{nameOf(l.series)}</code>
            </span>
          ))}
        </div>
        <div className={track}>
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => {
                localStorage.setItem(STORED, w.key);
                setWindowKey(w.key);
              }}
              className={choice(windowKey === w.key)}
            >
              {w.title}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={box}
        className="relative bg-black/30"
        onMouseMove={(e) => {
          const r = box.current!.getBoundingClientRect();
          setHover(start + ((e.clientX - r.left) / r.width) * (to - start));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-56 w-full"
          aria-label="Chart of the rule's values"
        >
          {bands.map((b) => {
            const center = lines.find((l) => l.series.id === b.centerId);
            if (!center) return null;
            const f = b.percent / 100;
            const edge = (k: number) =>
              pathOf(center.samples, (s) => Number(s.last) * k);
            return (
              <g key={b.centerId} opacity={0.5}>
                {b.sides !== "below" && (
                  <path
                    d={edge(1 + f)}
                    fill="none"
                    stroke={center.colour}
                    strokeDasharray="4 4"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {b.sides !== "above" && (
                  <path
                    d={edge(1 - f)}
                    fill="none"
                    stroke={center.colour}
                    strokeDasharray="4 4"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </g>
            );
          })}
          {/* Where the rule trips: shaded beyond each limit. */}
          {thresholds.map(
            (t) =>
              t.trips && (
                <rect
                  key={`${t.seriesId}:${t.value}:zone`}
                  x={0}
                  width={W}
                  y={t.trips === "above" ? 0 : y(Number(t.value))}
                  height={
                    t.trips === "above"
                      ? y(Number(t.value))
                      : H - y(Number(t.value))
                  }
                  fill="#ef4444"
                  opacity={0.06}
                />
              ),
          )}
          {boundaries.map((b) => {
            if (b.points.length < 2) return null;
            const line = b.points
              .map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.v)}`)
              .join("");
            const last = b.points[b.points.length - 1]!;
            const edge = b.trips === "above" ? 0 : H;
            return (
              <g key={b.key}>
                {b.trips && (
                  <path
                    d={`${line}L${x(last.t)},${edge}L${x(b.points[0]!.t)},${edge}Z`}
                    fill="#ef4444"
                    opacity={0.06}
                  />
                )}
                <path
                  d={line}
                  fill="none"
                  stroke="#f87171"
                  strokeDasharray="6 4"
                  opacity={0.7}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
          {lines.map((l) => (
            <g key={l.series.id}>
              <path d={rangeOf(l.samples)} fill={l.colour} opacity={0.12} />
              <path
                d={pathOf(l.samples, (s) => Number(s.last))}
                fill="none"
                stroke={l.colour}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          {thresholds.map((t) => (
            <line
              key={`${t.seriesId}:${t.value}`}
              x1={0}
              x2={W}
              y1={y(Number(t.value))}
              y2={y(Number(t.value))}
              stroke="#f87171"
              strokeDasharray="6 4"
              opacity={0.7}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={0}
              y2={H}
              stroke="white"
              opacity={0.15}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {/* Violations along the bottom: filled tripped, amber errors, hollow pending. */}
        {marks.map((v) => (
          <span
            key={v.id}
            title={`${v.kind === "tripped" ? "Tripped" : v.kind === "pending" ? "Pending" : "Error"} at block ${formatBig(String(v.blockNumber))}`}
            className={`absolute bottom-1 size-1.5 -translate-x-1/2 ${
              v.kind === "tripped"
                ? "bg-red-500"
                : v.kind === "pending"
                  ? "border border-sky-400"
                  : "bg-amber-400"
            }`}
            style={{ left: `${(x(Date.parse(v.blockTime)) / W) * 100}%` }}
          />
        ))}

        {thresholds.map((t) => (
          <span
            key={`${t.seriesId}:${t.value}:label`}
            className="absolute right-2 -translate-y-full font-mono text-[10px] text-red-400/80"
            style={{ top: `${(y(Number(t.value)) / H) * 100}%` }}
          >
            {t.label}
          </span>
        ))}

        {boundaries.map((b) => {
          const last = b.points[b.points.length - 1];
          if (!last || !b.label) return null;
          return (
            <span
              key={`${b.key}:label`}
              className="absolute right-2 -translate-y-full font-mono text-[10px] text-red-400/80"
              style={{ top: `${(y(last.v) / H) * 100}%` }}
            >
              {b.label}
            </span>
          );
        })}

        {/* The highest and lowest recorded values, at their own heights. */}
        {highest !== null && (
          <span
            className="absolute left-2 -translate-y-full font-mono text-[10px] text-gray-500"
            style={{ top: `${(y(Number(highest)) / H) * 100}%` }}
          >
            {showValue(highest, rule.display)}
          </span>
        )}
        {lowest !== null && lowest !== highest && (
          <span
            className="absolute left-2 font-mono text-[10px] text-gray-500"
            style={{ top: `${(y(Number(lowest)) / H) * 100}%` }}
          >
            {showValue(lowest, rule.display)}
          </span>
        )}

        {hover !== null && all.length > 0 && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-48 bg-panel px-3 py-2 text-xs shadow-lg shadow-black/50"
            style={
              x(hover) > W / 2
                ? { right: `${100 - (x(hover) / W) * 100 + 1}%` }
                : { left: `${(x(hover) / W) * 100 + 1}%` }
            }
          >
            {lines.map((l) => {
              const s = nearest(l.samples, hover);
              if (!s) return null;
              return (
                <div key={l.series.id} className="py-0.5">
                  <p className="font-mono text-white">
                    <span style={{ color: l.colour }}>■</span>{" "}
                    {showValue(s.last, rule.display)}
                  </p>
                  {s.count !== undefined && s.min !== s.max && (
                    <p className="font-mono text-gray-500">
                      {showValue(s.min, rule.display)} –{" "}
                      {showValue(s.max, rule.display)}
                    </p>
                  )}
                  <p className="text-gray-500">
                    {s.block !== undefined
                      ? `Block ${formatBig(String(s.block))} · `
                      : `${s.count} ${s.count === 1 ? "block" : "blocks"} from `}
                    {new Date(s.t).toLocaleString()}
                  </p>
                </div>
              );
            })}
          </div>
        )}

        {!loading && all.length === 0 && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-gray-500">
            Nothing recorded in this window.
          </p>
        )}
      </div>
      <p className="mt-2 flex justify-between font-mono text-[10px] text-gray-600">
        <span>{new Date(start).toLocaleString()}</span>
        {resolution && resolution !== "block" && (
          <span title="Each stretch shows its low and high behind the line">
            {resolution} a stretch
          </span>
        )}
        <span>now</span>
      </p>
    </div>
  );
}
