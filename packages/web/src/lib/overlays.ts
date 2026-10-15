import {
  formatDuration,
  type BoolNode,
  type RuleSeries,
  type SavedRule,
  type SeriesWindow,
  type ValueNode,
} from "@tripwire/shared";
import { showValue } from "./format";

// A rule's limits, worked out from its document and its recorded series the
// way the engine works them out: shared by the full chart on a rule's page
// and the preview that stands for the rule in lists, so the two never
// disagree about where a limit is.

export const OPS: Record<string, string> = {
  lt: "<",
  le: "≤",
  gt: ">",
  ge: "≥",
  eq: "=",
  ne: "≠",
};
export const FLIP: Record<string, string> = {
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

export function samplesOf(window: SeriesWindow | undefined): Sample[] {
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

export const sameCall = (node: ValueNode, s: RuleSeries, contract: string) =>
  node.node === "view_call" &&
  // A read, or the base a windowed metric is worked out over.
  (s.role === "read" || s.metric === null) &&
  (node.address ?? contract).toLowerCase() === s.call.address.toLowerCase() &&
  node.function === s.call.function &&
  JSON.stringify(node.args) === JSON.stringify(s.call.args) &&
  (node.returns ?? 0) === (s.call.returns ?? 0);

/** Which side of a boundary trips the rule. */
export type Trips = "above" | "below" | null;

/** The comparison that holds exactly when another does not. */
const NEGATE: Record<string, string> = {
  lt: "ge",
  le: "gt",
  gt: "le",
  ge: "lt",
  eq: "ne",
  ne: "eq",
};
export const TRIPS: Record<string, Trips> = {
  lt: "below",
  le: "below",
  gt: "above",
  ge: "above",
  eq: null,
  ne: null,
};

export interface Threshold {
  seriesId: string;
  value: string;
  label: string;
  trips: Trips;
  /** The comparison as it trips, so `le` and `ge` trip at the limit itself. */
  op: string;
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

export interface Boundary {
  key: string;
  /** `partial` where less than a whole window of history lies behind. */
  points: { t: number; v: number; partial?: boolean }[];
  trips: Trips;
  label: string;
}

export interface Band {
  /** The read the band holds, which the centre is worked out over. */
  valueId: string | null;
  centerId: string;
  percent: number;
  sides: "both" | "above" | "below";
}

/** Horizontal lines where a read is compared with a literal, and bands. */
export function overlaysOf(rule: SavedRule, series: RuleSeries[]) {
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

  // Under a `not` a comparison trips where it does not hold, so it is read
  // as its negation: `not (x >= 5)` trips below 5.
  const visit = (node: BoolNode, negated = false) => {
    if (node === true) return;
    const n =
      negated && node.node === "compare"
        ? { ...node, op: NEGATE[node.op]! as typeof node.op }
        : node;
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
              op,
            });
          }
        }
        derive(n);
        return;
      }
      case "deviation_band": {
        // A band under `not` trips inside it, which no band overlay shows.
        if (negated) return;
        const center = n.center;
        if (center.node !== "metric") return;
        // The recorded centre is the metric over the centre's own read.
        const s = series.find(
          (x) =>
            x.role === "metric" &&
            x.metric === center.metric &&
            (x.windowSeconds ?? null) === (center.window?.seconds ?? null) &&
            sameCall(center.of, { ...x, role: "read" }, contract),
        );
        if (s) {
          bands.push({
            valueId: readOf(n.value)?.id ?? null,
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
        n.terms.forEach((term) => visit(term, negated));
        return;
      case "not":
        visit(n.expr, !negated);
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
export function nameOf(s: RuleSeries) {
  const fn = s.call.function.replace(/ returns \(.*\)$/, "");
  return s.metric ? `${s.metric} of ${fn}` : fn;
}
