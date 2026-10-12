import type {
  RuleSeries,
  SavedRule,
  SeriesWindow,
  Violation,
} from "@tripwire/shared";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatBig, showValue } from "../lib/format";
import { timeAxis } from "../lib/timeAxis";
import {
  boundaryOf,
  nameOf,
  overlaysOf,
  samplesOf,
  type Sample,
} from "../lib/overlays";
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
  // Stretches where nothing was recorded are squeezed to a sliver, so what
  // was recorded fills the chart and the line runs on across the break.
  const axis = timeAxis(
    all.map((s) => s.t),
    start,
    to,
  );
  const x = (t: number) => axis.x(t) * W;
  const y = (v: number) => H - ((v - yLow) / (yHigh - yLow)) * H;

  /** The line through the samples, on across any squeezed stretch. */
  const pathOf = (samples: Sample[], pick: (s: Sample) => number) =>
    samples
      .map(
        (s, i) =>
          `${i ? "L" : "M"}${x(s.t).toFixed(1)},${y(pick(s)).toFixed(1)}`,
      )
      .join("");
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
          setHover(axis.time((e.clientX - r.left) / r.width));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-56 w-full"
          aria-label="Chart of the rule's values"
        >
          {axis.breaks.map((b) => {
            const at = x((b.from + b.to) / 2);
            return (
              <line
                key={b.from}
                x1={at}
                x2={at}
                y1={0}
                y2={H}
                stroke="#6b7280"
                strokeOpacity={0.5}
                strokeDasharray="2 4"
                vectorEffect="non-scaling-stroke"
              >
                <title>
                  {`Nothing recorded from ${new Date(b.from).toLocaleString()} to ${new Date(b.to).toLocaleString()}`}
                </title>
              </line>
            );
          })}
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
