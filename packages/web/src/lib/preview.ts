import type { RulePreview, SavedRule } from "@tripwire/shared";
import { formatBig, formatUnits } from "./format";
import {
  boundaryOf,
  nameOf,
  overlaysOf,
  samplesOf,
  type Sample,
  type Trips,
} from "./overlays";

// What a rule's preview draws, worked out from the rule's document and its
// preview read: the line, its limits from the same code
// as the full chart, how close the latest value is to them, and the scale.

export const WINDOW_MS = 24 * 3_600_000;

/** A line in the preview: a limit with the side that trips, or a band's centre. */
export interface PreviewLine {
  key: string;
  points: { t: number; v: number }[];
  trips: Trips;
  /** How the legend names the limit: "below 50", "±10% of the 1h avg". */
  words: string;
  /** A band's edge, shaded green between the two; a centre has no side. */
  role: "limit" | "edge" | "centre";
  /** Within this fraction of the limit the value counts as near it. */
  near: number;
}

export type Tone = "safe" | "near" | "breached" | "none";

export interface Scale {
  decimals: number | null;
  unit: string | null;
  /** The contract's own decimals(), used because the rule sets none. */
  auto: boolean;
}

export interface PreviewModel {
  /** The line: the rule's first recorded read. */
  primary: {
    name: string;
    samples: Sample[];
    latest: { raw: string; v: number; t: number } | null;
  } | null;
  lines: PreviewLine[];
  /** The tightest headroom, positive on the safe side; null when none applies. */
  headroom: number | null;
  tone: Tone;
  scale: Scale;
  /** The value range drawn, padded, and limits left off it as too far away. */
  range: {
    low: number;
    high: number;
    off: { words: string; side: "above" | "below" }[];
  };
  /** The event an event-triggered rule fires on, by name. */
  event: string | null;
}

const NEAR = 0.1;
const PAD = 0.12;
const FAR = 20;

/** The decimals() of the contract the rule's first read reads, when it has one. */
export function contractDecimals(
  preview: RulePreview | undefined,
): number | null {
  const first = preview?.series.find((s) => s.role === "read");
  if (!first) return null;
  return preview?.decimals[first.call.address.toLowerCase()] ?? null;
}

/** The rule's scale: its own display first, else its contract's decimals(). */
export function scaleOf(
  rule: SavedRule,
  preview: RulePreview | undefined,
): Scale {
  const unit = rule.display.unit;
  if (rule.display.decimals !== null) {
    return { decimals: rule.display.decimals, unit, auto: false };
  }
  const auto = contractDecimals(preview);
  return auto === null
    ? { decimals: null, unit, auto: false }
    : { decimals: auto, unit, auto: true };
}

/**
 * A value in the preview's scale, short: 100.2, 3,417.5, 1.2M; raw as
 * 1.000 × 10²⁰. With `span`, the axis's height, enough digits are kept that
 * the top and bottom of a narrow range do not read the same.
 */
export function compact(
  raw: string | number,
  scale: Scale,
  span?: number,
): string {
  const unit = scale.unit ? ` ${scale.unit}` : "";
  // Raw, chosen as 0 decimals, reads like no scale once it is long.
  const huge = scale.decimals === 0 && Math.abs(Number(raw)) >= 1e15;
  if (scale.decimals === null || huge) {
    const whole =
      typeof raw === "string"
        ? raw
        : Number.isFinite(raw)
          ? BigInt(Math.round(raw)).toString()
          : String(raw);
    const text = /^-?\d+$/.test(whole)
      ? formatBig(whole.replace(/^-/, "")).replace(
          /^/,
          whole.startsWith("-") ? "−" : "",
        )
      : whole;
    return `${text}${unit}`;
  }
  const n =
    typeof raw === "string" && /^-?\d+$/.test(raw)
      ? Number(formatUnits(raw, scale.decimals).replace(/,/g, ""))
      : Number(raw) / 10 ** scale.decimals;
  const abs = Math.abs(n);
  const width = span === undefined ? 0 : span / 10 ** scale.decimals;
  const significant =
    width > 0 && abs > 0
      ? Math.min(10, Math.max(3, Math.ceil(Math.log10(abs / width)) + 2))
      : null;
  const text = new Intl.NumberFormat("en", {
    notation: abs >= 1e6 ? "compact" : "standard",
    ...(significant
      ? { maximumSignificantDigits: significant }
      : {
          maximumFractionDigits:
            abs >= 1e6 ? 1 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4,
        }),
  }).format(n);
  return `${text}${unit}`;
}

/** The event a rule fires on, by name: "Transfer" for an event trigger. */
export function eventOf(rule: SavedRule): string | null {
  const when = rule.rule.when;
  if (typeof when !== "object" || !("event" in when)) return null;
  return when.event.replace(/\(.*$/, "").trim() || null;
}

/** How far a value is from a limit, as a fraction of it, positive when safe. */
export function headroomOf(
  v: number,
  limit: number,
  trips: Trips,
): number | null {
  if (trips === null) return null;
  const gap = trips === "below" ? v - limit : limit - v;
  if (limit === 0) return gap >= 0 ? Infinity : -Infinity;
  return gap / Math.abs(limit);
}

/** Green while safe, amber within `near` of the limit, red past it. */
export function toneOf(headroom: number | null, near = NEAR): Tone {
  if (headroom === null) return "none";
  if (headroom < 0) return "breached";
  return headroom < near ? "near" : "safe";
}

/** The range drawn: values and limits, padded, leaving off limits far away. */
export function rangeOf(
  values: number[],
  limits: { v: number[]; words: string }[],
): PreviewModel["range"] {
  if (values.length === 0 && limits.length === 0) {
    return { low: 0, high: 1, off: [] };
  }
  let low = Math.min(...values);
  let high = Math.max(...values);
  const span = high - low || Math.abs(high) || 1;
  const off: PreviewModel["range"]["off"] = [];
  for (const limit of limits) {
    const lo = Math.min(...limit.v);
    const hi = Math.max(...limit.v);
    if (values.length && lo > high + FAR * span) {
      off.push({ words: limit.words, side: "above" });
    } else if (values.length && hi < low - FAR * span) {
      off.push({ words: limit.words, side: "below" });
    } else {
      low = Math.min(low, lo);
      high = Math.max(high, hi);
    }
  }
  if (!Number.isFinite(low)) return { low: 0, high: 1, off };
  const pad = (high - low || Math.abs(high) || 1) * PAD;
  return { low: low - pad, high: high + pad, off };
}

const side = (trips: Trips) =>
  trips === "below" ? "below" : trips === "above" ? "above" : "at";

/** Everything a preview draws for one rule. */
export function previewOf(
  rule: SavedRule,
  preview: RulePreview | undefined,
  now: number,
): PreviewModel {
  const scale = scaleOf(rule, preview);
  const event = eventOf(rule);
  const first = preview?.series.find((s) => s.role === "read");
  if (!preview || !first) {
    return {
      primary: null,
      lines: [],
      headroom: null,
      tone: "none",
      scale,
      range: { low: 0, high: 1, off: [] },
      event,
    };
  }
  const samplesFor = (id: string) =>
    samplesOf({ resolution: "preview", buckets: preview.buckets[id] ?? [] });
  const samples = samplesFor(first.id);
  const newest = preview.latest[first.id];
  const latest = newest
    ? {
        raw: newest.value,
        v: Number(newest.value),
        t: Date.parse(newest.blockTime),
      }
    : null;
  const from = now - WINDOW_MS;
  const flat = (v: number) => [
    { t: from, v },
    { t: now, v },
  ];

  const { thresholds, bands, derived } = overlaysOf(rule, preview.series);
  const lines: PreviewLine[] = [];
  for (const t of thresholds.filter((x) => x.seriesId === first.id)) {
    lines.push({
      key: `threshold:${t.value}`,
      points: flat(Number(t.value)),
      trips: t.trips,
      words:
        t.trips !== null
          ? `${side(t.trips)} ${compact(t.value, scale)}`
          : `${t.label.startsWith("≠") ? "away from" : "at"} ${compact(t.value, scale)}`,
      role: "limit",
      near: NEAR,
    });
  }
  for (const d of derived.filter((x) => x.seriesId === first.id)) {
    const other =
      d.kind === "read"
        ? preview.series.find((s) => s.id === d.otherId)
        : undefined;
    const otherName = other ? nameOf(other) : "";
    const edges = boundaryOf(
      d,
      samples,
      other ? samplesFor(other.id) : [],
      otherName,
    );
    for (const b of edges) {
      const band = d.kind === "band";
      const words =
        d.kind === "read"
          ? `${side(b.trips)} ${otherName}`
          : d.kind === "age"
            ? b.label
            : band
              ? `outside ${edges.find((e) => e.label)?.label ?? b.label}`
              : `${side(b.trips)} ${b.label}`;
      lines.push({
        key: b.key,
        points: b.points.map((p) => ({ t: p.t, v: p.v })),
        trips: b.trips,
        words,
        role: band ? "edge" : "limit",
        near: band ? (0.4 * d.percent) / (100 + d.percent) : NEAR,
      });
    }
  }
  for (const b of bands) {
    const centre = preview.series.find((s) => s.id === b.centerId);
    if (!centre) continue;
    const points = samplesFor(centre.id).map((s) => ({
      t: s.t,
      v: Number(s.last),
    }));
    const f = b.percent / 100;
    const sign = b.sides === "both" ? "±" : b.sides === "above" ? "+" : "−";
    const words = `outside ${sign}${b.percent}% of ${nameOf(centre)}`;
    const near = (0.4 * f) / (1 + f);
    lines.push({
      key: "centre",
      points,
      trips: null,
      words,
      role: "centre",
      near,
    });
    if (b.sides !== "below") {
      lines.push({
        key: "band:above",
        points: points.map((p) => ({ ...p, v: p.v * (1 + f) })),
        trips: "above",
        words,
        role: "edge",
        near,
      });
    }
    if (b.sides !== "above") {
      lines.push({
        key: "band:below",
        points: points.map((p) => ({ ...p, v: p.v * (1 - f) })),
        trips: "below",
        words,
        role: "edge",
        near,
      });
    }
  }

  // The tightest limit at the latest value decides the colour.
  let headroom: number | null = null;
  let tone: Tone = "none";
  if (latest) {
    for (const line of lines) {
      const at = line.points.at(-1)?.v;
      if (at === undefined || line.trips === null) continue;
      const h = headroomOf(latest.v, at, line.trips);
      if (h === null) continue;
      const t = toneOf(h, line.near);
      const rank = { breached: 3, near: 2, safe: 1, none: 0 };
      if (
        headroom === null ||
        rank[t] > rank[tone] ||
        (t === tone && h < headroom)
      ) {
        headroom = h;
        tone = t;
      }
    }
    // An equality trips on the exact value, so it is safe or breached only.
    for (const t of thresholds.filter(
      (x) => x.seriesId === first.id && x.trips === null,
    )) {
      const equal = latest.raw === t.value;
      const hit = t.label.startsWith("≠") ? !equal : equal;
      if (hit) tone = "breached";
      else if (tone === "none") tone = "safe";
    }
  }

  const values = samples.flatMap((s) => [Number(s.min), Number(s.max)]);
  if (latest) values.push(latest.v);
  const range = rangeOf(
    values,
    lines.map((l) => ({ v: l.points.map((p) => p.v), words: l.words })),
  );
  return {
    primary: { name: nameOf(first), samples, latest },
    lines,
    headroom: headroom !== null && Number.isFinite(headroom) ? headroom : null,
    tone,
    scale,
    range,
    event,
  };
}
