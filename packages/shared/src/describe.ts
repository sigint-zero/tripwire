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

/**
 * Names a contract read, e.g. from the ABI's output names. Returning
 * nothing falls back to the method name.
 */
export type ReadNamer = (
  method: string,
  returnIndex: number,
) => string | undefined;

/** A value expression as a short formula, e.g. "totalAssets − totalDebt". */
export function describeValue(value: ValueExpr, name?: ReadNamer): string {
  const inner = (v: ValueExpr) => describeValue(v, name);
  switch (value.type) {
    case "view_call": {
      const named = name?.(value.method, value.return_index ?? 0);
      if (named) return named;
      const method = value.method.replace(/\(\)$/, "");
      return value.return_index ? `${method}[${value.return_index}]` : method;
    }
    case "literal":
      return formatUint(value.value);
    case "now":
      return "now";
    case "arithmetic":
      return `${inner(value.left)} ${ARITH[value.op]} ${inner(value.right)}`;
    case "sum":
      return value.operands.map(inner).join(" + ");
    case "scale":
      return value.denominator === 100
        ? `${value.numerator}% of ${inner(value.value)}`
        : `${inner(value.value)} × ${value.numerator}/${value.denominator}`;
    case "historical":
      return `${metric(value.metric)} of ${inner(value.source)}`;
  }
}

export function describeCondition(
  condition: Condition,
  name?: ReadNamer,
): string {
  const value = (v: ValueExpr) => describeValue(v, name);
  const nested = (c: Condition) => describeCondition(c, name);
  switch (condition.type) {
    case "compare":
      return `${value(condition.left)} ${OPS[condition.op]} ${value(condition.right)}`;
    case "deviation_band": {
      const direction = condition.downward_only
        ? "below"
        : condition.upward_only
          ? "above"
          : "of";
      return `${value(condition.value)} within ${condition.band_percent}% ${direction} ${value(condition.center)}`;
    }
    case "and":
      return condition.conditions.map(nested).join(" AND ");
    case "or":
      return condition.conditions.map(nested).join(" OR ");
    case "not":
      return `NOT (${nested(condition.condition)})`;
  }
}

/** The values a condition compares, in the order a dry run reports them. */
export function comparedValues(condition: Condition): ValueExpr[] {
  if (condition.type === "compare") return [condition.left, condition.right];
  if (condition.type === "deviation_band") {
    return [condition.value, condition.center];
  }
  return [];
}

/** The rule as a one-line equation of what must stay true. */
export function describeRule(rule: Rule, name?: ReadNamer): string {
  if (rule.kind === "expression")
    return describeCondition(rule.condition, name);
  const event = rule.event.replace(/\(.*$/, "");
  return rule.condition === "must_not_appear"
    ? `${event} never emitted`
    : `${event} emitted`;
}
