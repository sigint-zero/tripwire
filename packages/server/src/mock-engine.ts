import {
  describeValue,
  type Condition,
  type Invariant,
  type InvariantDraft,
  type Rule,
  type RulePreview,
  type ValueExpr,
} from "@tripwire/shared";
import { randomUUID } from "node:crypto";

// Development stand-in for the engine: keeps invariants in memory and
// previews rules against simulated values that drift slowly over time, so
// the dashboard can be built and demonstrated before the engine exists.

const WAD = 10n ** 18n;

/** A stable number in [0, 1) derived from a string. */
function unit(seed: string): number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) / 2 ** 32;
}

/** Scales a value by a fraction, keeping it an integer. */
function times(value: bigint, factor: number): bigint {
  return (value * BigInt(Math.round(factor * 1_000_000))) / 1_000_000n;
}

function nowSeconds(clock: number): bigint {
  return BigInt(Math.floor(clock / 1000));
}

function read(call: Extract<ValueExpr, { type: "view_call" }>, clock: number) {
  const seed = `${call.contract.toLowerCase()}:${call.method}:${call.return_index ?? 0}`;
  // Timestamps look like a feed that updated within the last half hour.
  if (/updated|timestamp|time|latestRound/i.test(call.method)) {
    return nowSeconds(clock) - BigInt(Math.floor(unit(seed) * 1_800));
  }
  if (/^decimals\(/.test(call.method)) return 18n;
  // Everything else: a token-sized amount. Reads from one contract sit
  // within a few percent of each other and wobble by up to ±0.5%.
  const size = unit(call.contract.toLowerCase());
  const base = BigInt(Math.floor(1_000 + size * 9_000_000)) * WAD;
  const offset = (unit(seed) - 0.5) * 0.06;
  const wobble = Math.sin(clock / 20_000 + unit(seed) * 6.28) * 0.005;
  return times(base, 1 + offset + wobble);
}

export function evaluate(value: ValueExpr, clock: number): bigint {
  switch (value.type) {
    case "view_call":
      return read(value, clock);
    case "literal":
      return BigInt(value.value);
    case "now":
      return nowSeconds(clock);
    case "sum":
      return value.operands.reduce(
        (total, v) => total + evaluate(v, clock),
        0n,
      );
    case "scale":
      return (
        (evaluate(value.value, clock) * BigInt(value.numerator)) /
        BigInt(value.denominator)
      );
    case "arithmetic": {
      const left = evaluate(value.left, clock);
      const right = evaluate(value.right, clock);
      if (value.op === "add") return left + right;
      if (value.op === "sub") return left > right ? left - right : 0n;
      if (value.op === "mul") return left * right;
      return right === 0n ? 0n : left / right;
    }
    case "historical": {
      const source = evaluate(value.source, clock);
      switch (value.metric.type) {
        case "ath":
          return times(source, 1.02);
        case "prev_block":
          return times(source, 0.9995);
        case "moving_avg":
        case "twap":
          return times(source, 1 - Math.sin(clock / 20_000) * 0.004);
        case "windowed_delta":
          return times(source, 0.012);
        case "windowed_drop":
          return times(source, 0.006);
      }
    }
  }
}

function holds(condition: Condition, clock: number): boolean {
  switch (condition.type) {
    case "compare": {
      const l = evaluate(condition.left, clock);
      const r = evaluate(condition.right, clock);
      const ops = {
        eq: l === r,
        neq: l !== r,
        gt: l > r,
        gte: l >= r,
        lt: l < r,
        lte: l <= r,
      };
      return ops[condition.op];
    }
    case "deviation_band": {
      const v = evaluate(condition.value, clock);
      const c = evaluate(condition.center, clock);
      if (condition.downward_only && v >= c) return true;
      if (condition.upward_only && v <= c) return true;
      const diff = v > c ? v - c : c - v;
      return diff * 100n <= c * BigInt(condition.band_percent);
    }
    case "and":
      return condition.conditions.every((c) => holds(c, clock));
    case "or":
      return condition.conditions.some((c) => holds(c, clock));
    case "not":
      return !holds(condition.condition, clock);
  }
}

/** Percentage of `of` that `part` represents, to one decimal place. */
function percent(part: bigint, of: bigint): string {
  if (of === 0n) return "0";
  return (Number((part * 10_000n) / of) / 100).toFixed(1);
}

export function preview(rule: Rule, clock = Date.now()): RulePreview {
  if (rule.kind === "log") {
    return {
      holds: rule.condition === "must_not_appear",
      terms: [],
      detail:
        rule.condition === "must_not_appear"
          ? "Not emitted in the last 1,000 blocks"
          : "Waiting for the event",
      simulated: true,
    };
  }
  const condition = rule.condition;
  const ok = holds(condition, clock);
  if (condition.type === "compare") {
    const l = evaluate(condition.left, clock);
    const r = evaluate(condition.right, clock);
    const gap = l > r ? l - r : r - l;
    return {
      holds: ok,
      terms: [
        { label: describeValue(condition.left), value: l.toString() },
        { label: describeValue(condition.right), value: r.toString() },
      ],
      detail: ok
        ? `${percent(gap, r > 0n ? r : l)}% margin`
        : `${percent(gap, r > 0n ? r : l)}% past the limit`,
      simulated: true,
    };
  }
  if (condition.type === "deviation_band") {
    const v = evaluate(condition.value, clock);
    const c = evaluate(condition.center, clock);
    const deviation = percent(v > c ? v - c : c - v, c);
    return {
      holds: ok,
      terms: [
        { label: describeValue(condition.value), value: v.toString() },
        { label: describeValue(condition.center), value: c.toString() },
      ],
      detail: `${deviation}% from center, limit ${condition.band_percent}%`,
      simulated: true,
    };
  }
  return { holds: ok, terms: [], detail: "", simulated: true };
}

export class MockEngine {
  #invariants = new Map<string, Invariant>();

  list(): Invariant[] {
    return [...this.#invariants.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  create(draft: InvariantDraft): Invariant {
    const invariant: Invariant = {
      ...draft,
      id: randomUUID(),
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.#invariants.set(invariant.id, invariant);
    return invariant;
  }
}
