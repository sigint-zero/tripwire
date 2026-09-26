import { formatDuration, type Rule } from "@tripwire/shared";

// Scripted series for the trip simulation when a rule's limit moves with
// the value: a band around a trailing average, a ceiling on growth within a
// window, or a floor under the window's high. The limit is computed from the
// series the way the engine computes it, so the two curves agree.

/** A rule whose limit rolls with the value, in the terms the chart needs. */
export type Rolling =
  | {
      kind: "band";
      percent: number;
      window: number;
      sides: "both" | "above" | "below";
    }
  | { kind: "growth"; percent: number | null; window: number }
  | { kind: "drop"; percent: number; window: number };

export function rollingOf(rule: Rule): Rolling | null {
  const trip = rule.trip_when;
  if (rule.when !== "every_block" || trip === true) return null;
  if (trip.node === "deviation_band") {
    const center = trip.center;
    if (center.node !== "metric" || !center.window) return null;
    return {
      kind: "band",
      percent: Number(trip.tolerance_percent),
      window: center.window.seconds,
      sides: trip.sides,
    };
  }
  if (trip.node !== "compare" || (trip.op !== "gt" && trip.op !== "ge")) {
    return null;
  }
  const { left, right } = trip;
  if (left.node !== "metric" || !left.window) return null;
  const window = left.window.seconds;
  if (left.metric === "windowed_drop" && right.node === "literal") {
    return { kind: "drop", percent: Number(right.value), window };
  }
  if (left.metric === "windowed_delta") {
    // As a share of the value: value × fraction.
    const fraction =
      right.node === "arithmetic" &&
      right.op === "mul" &&
      right.right.node === "literal"
        ? Math.round(Number(right.right.value) * 10_000) / 100
        : null;
    return { kind: "growth", percent: fraction, window };
  }
  return null;
}

/** What the limit line says, e.g. "±5% of 20m avg". */
export function rollingLabel(r: Rolling): string {
  const w = formatDuration(r.window);
  const p = (n: number | null) => (n === null ? "limit" : `${n}%`);
  if (r.kind === "band") {
    const sign = r.sides === "both" ? "±" : r.sides === "above" ? "+" : "−";
    return `${sign}${p(r.percent)} of ${w} avg`;
  }
  if (r.kind === "growth") return `+${p(r.percent)} in ${w}`;
  return `−${p(r.percent)} from ${w} high`;
}

// Samples: a window is W wide; the chart keeps PRE before the breach and
// POST after, so the breach lands at 55% of the width.
export const W = 45;
const PRE = 110;
const POST = 90;
export const SAMPLES = PRE + POST;
export const BREACH_INDEX = PRE;

export interface Series {
  values: number[];
  /** The limit above the value, where there is one. */
  upper?: number[];
  /** The limit below the value, where there is one. */
  lower?: number[];
  /** The trailing average a band is centred on. */
  center?: number[];
}

// A little movement so the line reads as a live value, the same every time.
const noise = (i: number) =>
  0.35 * Math.sin(i * 0.37) +
  0.25 * Math.sin(i * 0.91 + 1) +
  0.15 * Math.sin(i * 2.3 + 2);

const ease = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/** The series around the first breach, SAMPLES long with the breach at BREACH_INDEX. */
export function rollingSeries(r: Rolling): Series {
  // Shown between 3% and 20%, so small and large limits both read.
  const q = Math.min(20, Math.max(3, r.percent ?? 5)) / 100;
  const length = W + SAMPLES + W;
  const start = W + PRE; // where the scripted move begins, near the breach
  const v: number[] = [];
  for (let i = 0; i < length; i++) {
    let x = 100 * (1 + noise(i) / 100);
    if (r.kind === "band") {
      const dir = r.sides === "below" ? -1 : 1;
      const up = ease((i - (start - 6)) / 8);
      const down = ease((i - (start + 14)) / 40);
      x += dir * 100 * q * 1.9 * (up - down);
    } else if (r.kind === "growth") {
      x *= 1 + (0.012 * i) / W; // steady growth, well inside the limit
      x += 100 * q * 2.4 * ease((i - (start - 22)) / 32);
    } else {
      x -= 100 * q * 2.4 * ease((i - (start - 12)) / 36);
    }
    v.push(x);
  }

  const upper: number[] = [];
  const lower: number[] = [];
  const center: number[] = [];
  for (let i = 0; i < length; i++) {
    const from = Math.max(0, i - W);
    const win = v.slice(from, i + 1);
    if (r.kind === "band") {
      const avg = win.reduce((a, b) => a + b, 0) / win.length;
      center.push(avg);
      upper.push(avg * (1 + q));
      lower.push(avg * (1 - q));
    } else if (r.kind === "growth") {
      // The rise over the window may be at most q of the current value.
      upper.push(v[from]! / (1 - q));
    } else {
      lower.push(Math.max(...win) * (1 - q));
    }
  }

  const breaks = (i: number) => {
    if (r.kind === "band") {
      return (
        (r.sides !== "below" && v[i]! > upper[i]!) ||
        (r.sides !== "above" && v[i]! < lower[i]!)
      );
    }
    return r.kind === "growth" ? v[i]! > upper[i]! : v[i]! < lower[i]!;
  };
  let breach = W;
  while (breach < length - POST && !breaks(breach)) breach++;
  const cut = (xs: number[]) => xs.slice(breach - PRE, breach + POST);

  const series: Series = { values: cut(v) };
  if (r.kind === "band") {
    series.center = cut(center);
    if (r.sides !== "below") series.upper = cut(upper);
    if (r.sides !== "above") series.lower = cut(lower);
  } else if (r.kind === "growth") {
    series.upper = cut(upper);
  } else {
    series.lower = cut(lower);
  }
  return series;
}
