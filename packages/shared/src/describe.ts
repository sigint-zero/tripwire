import {
  shortSignature,
  type BoolNode,
  type CompareOp,
  type OnTrip,
  type Rule,
  type ValueNode,
  type ViewCall,
} from "./rule";

const ARITH = { add: "+", sub: "−", mul: "×", div: "÷" };
const COMPARE: Record<CompareOp, string> = {
  lt: "falls below",
  le: "is at most",
  gt: "rises above",
  ge: "is at least",
  eq: "equals",
  ne: "differs from",
};

/**
 * Writes a decimal string readably: thousands separators, or e-notation
 * for a whole number too long to scan.
 */
export function formatNumber(value: string | bigint): string {
  const text = typeof value === "bigint" ? value.toString() : value;
  const negative = text.startsWith("-");
  const [whole = "0", fraction] = text.replace(/^-/, "").split(".");
  const digits = whole.replace(/^0+(?=\d)/, "");
  const body =
    digits.length > 21 && !fraction
      ? `${digits[0]}.${digits.slice(1, 4)}e${digits.length - 1}`
      : `${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
  return negative ? `-${body}` : body;
}

/** "24h", "30m", "90s"; the largest unit that divides evenly. */
export function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * Names a contract read, e.g. from the ABI's output names. Returning
 * nothing falls back to the function signature.
 */
export type CallNamer = (call: ViewCall) => string | undefined;

function describeCall(call: ViewCall, name?: CallNamer): string {
  const named = name?.(call);
  if (named) return named;
  const short = shortSignature(call.function);
  const fn = call.returns === undefined ? short : `${short}[${call.returns}]`;
  return call.address ? `${fn} of ${call.address}` : fn;
}

/** A value node as a short phrase, e.g. "totalAssets() − totalDebt()". */
export function describeValue(value: ValueNode, name?: CallNamer): string {
  const inner = (v: ValueNode) => {
    const text = describeValue(v, name);
    return v.node === "arithmetic" ? `(${text})` : text;
  };
  switch (value.node) {
    case "view_call":
      return describeCall(value, name);
    case "literal":
      // Against an address, bool or bytes operand it holds that form.
      return /^-?\d+(\.\d+)?$/.test(value.value)
        ? formatNumber(value.value)
        : value.value;
    case "event_arg":
      return `the event's ${value.arg}`;
    case "now":
      return "now";
    case "arithmetic":
      return `${inner(value.left)} ${ARITH[value.op]} ${inner(value.right)}`;
    case "sum":
      return value.terms.map(inner).join(" + ");
    case "scale":
      return `${inner(value.expr)} × 10^${value.decimals}`;
    case "simulate":
      return `the result of ${shortSignature(value.call.function)}`;
    case "metric": {
      const of = describeCall(value.of, name);
      const span = value.window ? formatDuration(value.window.seconds) : "";
      switch (value.metric) {
        case "ath":
          return `the all-time high of ${of}`;
        case "prev_block":
          return `${of} at the previous block`;
        case "moving_avg":
          return `the ${span} moving average of ${of}`;
        case "twap":
          return `the ${span} time-weighted average of ${of}`;
        case "windowed_delta":
          return `the ${span} change in ${of}`;
        case "windowed_drop":
          return `the ${span} percent drop in ${of}`;
      }
    }
  }
}

/** A condition as a clause, e.g. "totalAssets() falls below totalSupply()". */
export function describeCondition(node: BoolNode, name?: CallNamer): string {
  if (node === true) return "it happens";
  const value = (v: ValueNode) => describeValue(v, name);
  const nested = (n: BoolNode) => `(${describeCondition(n, name)})`;
  switch (node.node) {
    case "compare":
      return `${value(node.left)} ${COMPARE[node.op]} ${value(node.right)}`;
    case "deviation_band": {
      const p = node.tolerance_percent;
      if (node.sides === "above") {
        return `${value(node.value)} rises more than ${p}% above ${value(node.center)}`;
      }
      if (node.sides === "below") {
        return `${value(node.value)} falls more than ${p}% below ${value(node.center)}`;
      }
      return `${value(node.value)} moves more than ${p}% away from ${value(node.center)}`;
    }
    case "simulate":
      return `a call to ${node.call.function} reverts`;
    case "and":
      return node.terms.map(nested).join(" and ");
    case "or":
      return node.terms.map(nested).join(" or ");
    case "not":
      return `not ${nested(node.expr)}`;
  }
}

/** The values a condition compares, in order. */
export function comparedValues(node: BoolNode): ValueNode[] {
  if (node === true) return [];
  if (node.node === "compare") return [node.left, node.right];
  if (node.node === "deviation_band") return [node.value, node.center];
  return [];
}

/**
 * The whole rule as one sentence, in the engine's style: "On every block,
 * notify when totalAssets() falls below totalSupply() (critical)."
 */
export function describeRule(rule: Rule, name?: CallNamer): string {
  const trigger =
    rule.when === "every_block"
      ? "On every block"
      : `On each ${rule.when.event.replace(/\(.*$/, "")} event`;
  const action = describeAction(rule.on_trip);
  const condition =
    rule.trip_when === true
      ? ""
      : ` when ${describeCondition(rule.trip_when, name)}`;
  const cooldown = rule.on_trip.cooldown_seconds
    ? `, ${formatDuration(rule.on_trip.cooldown_seconds)} cooldown`
    : "";
  return `${trigger}, ${action}${condition} (${rule.severity}${cooldown}).`;
}

/** What a trip does, as the engine's sentence says it. */
export function describeAction(onTrip: OnTrip): string {
  switch (onTrip.action) {
    case "notify":
      return "notify";
    case "trip_global":
      return "trip the whole contract";
    case "trip_function":
      return `trip ${onTrip.function}`;
    case "call": {
      const { function: fn, args, address } = onTrip.call;
      const name = fn.slice(0, fn.indexOf("("));
      const target = address ? ` on ${address}` : "";
      return `call ${name}(${args.join(", ")})${target}`;
    }
  }
}
