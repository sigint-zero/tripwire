import type { BoolNode, ValueNode } from "@tripwire/shared";
import { createHash } from "node:crypto";
import type { Evidence } from "./types";

// Simulated chain values for the stand-in: every read returns a plausible
// number that drifts slowly, so rules can be checked and charts drawn
// before the engine exists. Evaluation mirrors the engine's semantics and
// produces evidence in the engine's shape.

const WAD = 10n ** 18n;
/** Values are exact decimals, held as integers scaled by 10^18. */
const SCALE = 10n ** 18n;

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

/** A simulated contract read, as the raw integer the chain would return. */
export function simulatedRead(
  contract: string,
  fn: string,
  returns: number,
  clock: number,
): bigint {
  const seed = `${contract.toLowerCase()}:${fn}:${returns}`;
  // Timestamps look like a feed that updated within the last half hour.
  if (/updated|timestamp|time|latestRound/i.test(fn)) {
    return nowSeconds(clock) - BigInt(Math.floor(unit(seed) * 1_800));
  }
  if (/^decimals\(/.test(fn)) return 18n;
  if (/chainid/i.test(fn)) return 1n;
  // Everything else: a token-sized amount. Reads from one contract sit
  // within a few percent of each other. They drift over hours, ripple
  // over minutes and jitter a little from block to block, within ±0.5%,
  // so a chart of them looks like a market rather than noise.
  const size = unit(contract.toLowerCase());
  const base = BigInt(Math.floor(1_000 + size * 9_000_000)) * WAD;
  const offset = (unit(seed) - 0.5) * 0.06;
  const phase = unit(seed) * 6.28;
  const block = Math.floor(clock / 12_000);
  const wobble =
    Math.sin(clock / 2_700_000 + phase) * 0.0032 +
    Math.sin(clock / 190_000 + phase * 2) * 0.001 +
    (unit(`${seed}:${block}`) - 0.5) * 0.0006;
  return times(base, 1 + offset + wobble);
}

/** A simulated read of one output, in the form its ABI type takes. */
export function simulatedValue(
  contract: string,
  fn: string,
  returns: number,
  type: string,
  clock: number,
): string {
  const seed = `${contract.toLowerCase()}:${fn}:${returns}`;
  if (type === "address") {
    return `0x${createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;
  }
  if (type === "bool") return "false";
  if (type === "string") return "simulated";
  if (type.startsWith("bytes")) return "0x";
  return simulatedRead(contract, fn, returns, clock).toString();
}

/** The block the stand-in pretends the chain is at: one every 12 seconds. */
export function blockAt(clock: number): number {
  return 21_000_000 + Math.floor((clock - Date.UTC(2026, 0, 1)) / 12_000);
}

function fromDecimal(text: string): bigint {
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace(/^-/, "").split(".");
  const value =
    BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, "0").slice(0, 18));
  return negative ? -value : value;
}

function toDecimal(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

interface Context {
  contract: string;
  clock: number;
}

type Valued = { evidence: Evidence; value: bigint | null };

/** A node that was not reached, with everything beneath it. */
function unevaluated(node: unknown): Evidence {
  return { ...(node as object), state: "unevaluated" };
}

function valued(
  node: object,
  value: bigint | null,
  extra: object = {},
): Valued {
  return {
    value,
    evidence: {
      ...node,
      ...extra,
      ...(value === null ? { state: "warming" } : { value: toDecimal(value) }),
    },
  };
}

/** A value, or null while it cannot be known (a metric still warming up). */
function evaluate(node: ValueNode, ctx: Context): Valued {
  switch (node.node) {
    case "view_call": {
      const raw = simulatedRead(
        node.address ?? ctx.contract,
        node.function,
        node.returns ?? 0,
        ctx.clock,
      );
      // A read's evidence is the raw integer the chain returned.
      return {
        value: raw * SCALE,
        evidence: { ...node, value: raw.toString() },
      };
    }
    case "simulate": {
      const raw = simulatedRead(
        node.call.address ?? ctx.contract,
        node.call.function,
        node.returns ?? 0,
        ctx.clock,
      );
      return {
        value: raw * SCALE,
        evidence: { ...node, value: raw.toString() },
      };
    }
    case "literal":
      return valued(node, fromDecimal(node.value));
    case "now":
      return valued(node, nowSeconds(ctx.clock) * SCALE);
    case "event_arg":
      // No log at the head: an event argument has no value in a check.
      return { value: null, evidence: { ...node, state: "unevaluated" } };
    case "metric": {
      // A new rule has no history yet, so every metric is warming.
      const of = evaluate(node.of, ctx);
      return {
        value: null,
        evidence: { ...node, of: of.evidence, state: "warming" },
      };
    }
    case "scale": {
      const inner = evaluate(node.expr, ctx);
      const factor = 10n ** BigInt(Math.abs(node.decimals));
      const value =
        inner.value === null
          ? null
          : node.decimals >= 0
            ? inner.value * factor
            : inner.value / factor;
      return valued(node, value, { expr: inner.evidence });
    }
    case "sum": {
      const terms = node.terms.map((t) => evaluate(t, ctx));
      const value = terms.some((t) => t.value === null)
        ? null
        : terms.reduce((a, t) => a + t.value!, 0n);
      return valued(node, value, { terms: terms.map((t) => t.evidence) });
    }
    case "arithmetic": {
      const l = evaluate(node.left, ctx);
      const r = evaluate(node.right, ctx);
      let value: bigint | null = null;
      if (l.value !== null && r.value !== null) {
        if (node.op === "add") value = l.value + r.value;
        else if (node.op === "sub") value = l.value - r.value;
        else if (node.op === "mul") value = (l.value * r.value) / SCALE;
        else value = r.value === 0n ? null : (l.value * SCALE) / r.value;
      }
      return valued(node, value, { left: l.evidence, right: r.evidence });
    }
  }
}

type Judged = { evidence: Evidence; holds: boolean | null };

function judged(node: object, holds: boolean | null, extra: object): Judged {
  return {
    holds,
    evidence: {
      ...node,
      ...extra,
      ...(holds === null ? { state: "warming" } : { value: holds }),
    },
  };
}

/**
 * Whether the condition holds, or null when part of it cannot be known.
 * Unknown never trips. Branches past a deciding term are not evaluated.
 */
function evaluateBool(node: BoolNode, ctx: Context): Judged {
  if (node === true) return { holds: true, evidence: { value: true } };
  switch (node.node) {
    case "compare": {
      const l = evaluate(node.left, ctx);
      const r = evaluate(node.right, ctx);
      let holds: boolean | null = null;
      if (l.value !== null && r.value !== null) {
        const a = l.value;
        const b = r.value;
        holds = {
          eq: a === b,
          ne: a !== b,
          lt: a < b,
          le: a <= b,
          gt: a > b,
          ge: a >= b,
        }[node.op];
      }
      return judged(node, holds, { left: l.evidence, right: r.evidence });
    }
    case "deviation_band": {
      const v = evaluate(node.value, ctx);
      const c = evaluate(node.center, ctx);
      let holds: boolean | null = null;
      if (v.value !== null && c.value !== null) {
        const center = c.value;
        const limit =
          ((center < 0n ? -center : center) *
            fromDecimal(node.tolerance_percent)) /
          (100n * SCALE);
        const diff = v.value - center;
        holds =
          node.sides === "above"
            ? diff > limit
            : node.sides === "below"
              ? -diff > limit
              : (diff < 0n ? -diff : diff) > limit;
      }
      return judged(node, holds, { value: v.evidence, center: c.evidence });
    }
    case "simulate":
      // The stand-in's simulated calls never revert.
      return { holds: false, evidence: { ...node, value: false } };
    case "and":
    case "or": {
      const deciding = node.node === "or";
      const terms: Evidence[] = [];
      let holds: boolean | null = !deciding;
      for (const term of node.terms) {
        if (holds === deciding) {
          terms.push(unevaluated(term));
          continue;
        }
        const result = evaluateBool(term, ctx);
        terms.push(result.evidence);
        if (result.holds === deciding) holds = deciding;
        else if (result.holds === null) holds = null;
      }
      return judged(node, holds, { terms });
    }
    case "not": {
      const inner = evaluateBool(node.expr, ctx);
      return judged(node, inner.holds === null ? null : !inner.holds, {
        expr: inner.evidence,
      });
    }
  }
}

/** Evaluates `trip_when` once at the current block, as a dry run does. */
export function evaluateTrip(
  tripWhen: BoolNode,
  contract: string,
  clock: number,
): { would_trip: boolean; warming: boolean; evidence: Evidence } {
  const { holds, evidence } = evaluateBool(tripWhen, { contract, clock });
  return { would_trip: holds === true, warming: holds === null, evidence };
}

/** The longest metric window in a condition: how long a new rule warms up. */
export function warmupSeconds(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const own =
    (node as { node?: string }).node === "metric"
      ? ((node as { window?: { seconds?: number } }).window?.seconds ?? 0)
      : 0;
  return Math.max(own, ...Object.values(node).map(warmupSeconds));
}
