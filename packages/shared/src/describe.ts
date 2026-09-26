import type { Condition, HistoricalMetric, Rule, ValueExpr } from "./rule";

const OPS = { eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤" };
const ARITH = { add: "+", sub: "−", mul: "×", div: "÷" };

/** Writes a whole number with thousands separators, or in e-notation when huge. */
export function formatUint(value: string | bigint): string {
  const n = typeof value === "bigint" ? value : BigInt(value);
  const digits = n.toString();
  if (digits.length > 21) {
    return `${digits[0]}.${digits.slice(1, 4)}e${digits.length - 1}`;
  }
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "24h", "30m", "90s"; the largest unit that divides evenly. */
export function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function metric(m: HistoricalMetric): string {
  switch (m.type) {
    case "ath":
      return "all-time high";
    case "prev_block":
      return "previous block";
    case "moving_avg":
      return `${m.window}-block average`;
    case "twap":
      return `${formatDuration(m.window_secs)} average`;
    case "windowed_delta":
      return `${formatDuration(m.window_secs)} change`;
    case "windowed_drop":
      return `${formatDuration(m.window_secs)} drop`;
  }
}

/** A value expression as a short formula, e.g. "totalAssets − totalDebt". */
export function describeValue(value: ValueExpr): string {
  switch (value.type) {
    case "view_call": {
      const name = value.method.replace(/\(\)$/, "");
      return value.return_index ? `${name}[${value.return_index}]` : name;
    }
    case "literal":
      return formatUint(value.value);
    case "now":
      return "now";
    case "arithmetic":
      return `${describeValue(value.left)} ${ARITH[value.op]} ${describeValue(value.right)}`;
    case "sum":
      return value.operands.map(describeValue).join(" + ");
    case "scale":
      return value.denominator === 100
        ? `${value.numerator}% of ${describeValue(value.value)}`
        : `${describeValue(value.value)} × ${value.numerator}/${value.denominator}`;
    case "historical":
      return `${metric(value.metric)} of ${describeValue(value.source)}`;
  }
}

export function describeCondition(condition: Condition): string {
  switch (condition.type) {
    case "compare":
      return `${describeValue(condition.left)} ${OPS[condition.op]} ${describeValue(condition.right)}`;
    case "deviation_band": {
      const direction = condition.downward_only
        ? "below"
        : condition.upward_only
          ? "above"
          : "of";
      return `${describeValue(condition.value)} within ${condition.band_percent}% ${direction} ${describeValue(condition.center)}`;
    }
    case "and":
      return condition.conditions.map(describeCondition).join(" AND ");
    case "or":
      return condition.conditions.map(describeCondition).join(" OR ");
    case "not":
      return `NOT (${describeCondition(condition.condition)})`;
  }
}

/** The rule as a one-line equation of what must stay true. */
export function describeRule(rule: Rule): string {
  if (rule.kind === "expression") return describeCondition(rule.condition);
  const event = rule.event.replace(/\(.*$/, "");
  return rule.condition === "must_not_appear"
    ? `${event} never emitted`
    : `${event} emitted`;
}
