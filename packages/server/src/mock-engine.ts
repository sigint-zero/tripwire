import {
  describeRule,
  type BoolNode,
  type Contract,
  type ContractDetail,
  type EngineInfo,
  type Rule,
  type RuleCheck,
  type SavedRule,
  type ValueNode,
} from "@tripwire/shared";
import { randomBytes } from "node:crypto";

// Development stand-in for the engine: keeps contracts and rules in memory
// and checks rules against simulated values that drift slowly over time, so
// the dashboard can be built and demonstrated before the engine exists.

/** The engine's setup as the stand-in pretends it: Ethereum, trips held for approval. */
export const STAND_IN: EngineInfo = {
  chainId: 1,
  responseMode: "prepare",
  simulated: true,
};

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
function simulatedRead(
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
  // within a few percent of each other and wobble by up to ±0.5%.
  const size = unit(contract.toLowerCase());
  const base = BigInt(Math.floor(1_000 + size * 9_000_000)) * WAD;
  const offset = (unit(seed) - 0.5) * 0.06;
  const wobble = Math.sin(clock / 6_000 + unit(seed) * 6.28) * 0.005;
  return times(base, 1 + offset + wobble);
}

function fromDecimal(text: string): bigint {
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace(/^-/, "").split(".");
  const value =
    BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, "0").slice(0, 18));
  return negative ? -value : value;
}

interface Evaluation {
  contract: string;
  clock: number;
  reads: Map<string, { call: string; value: string }>;
  warmupSeconds: number;
}

/** A value, or null while it cannot be known (a metric still warming up). */
function evaluate(node: ValueNode, ev: Evaluation): bigint | null {
  const both = (l: ValueNode, r: ValueNode) => {
    const left = evaluate(l, ev);
    const right = evaluate(r, ev);
    return left === null || right === null ? null : ([left, right] as const);
  };
  switch (node.node) {
    case "view_call": {
      const contract = node.address ?? ev.contract;
      const returns = node.returns ?? 0;
      const raw = simulatedRead(contract, node.function, returns, ev.clock);
      const call =
        node.returns === undefined
          ? node.function
          : `${node.function}[${node.returns}]`;
      const label = node.address ? `${call} of ${node.address}` : call;
      ev.reads.set(label, { call: label, value: raw.toString() });
      return raw * SCALE;
    }
    case "simulate":
      return (
        simulatedRead(
          node.call.address ?? ev.contract,
          node.call.function,
          node.returns ?? 0,
          ev.clock,
        ) * SCALE
      );
    case "literal":
      return fromDecimal(node.value);
    case "now":
      return nowSeconds(ev.clock) * SCALE;
    case "event_arg":
      return null;
    case "metric":
      // A new rule has no history yet, so every metric is warming.
      evaluate(node.of, ev);
      ev.warmupSeconds = Math.max(ev.warmupSeconds, node.window?.seconds ?? 0);
      return null;
    case "scale": {
      const value = evaluate(node.expr, ev);
      if (value === null) return null;
      const factor = 10n ** BigInt(Math.abs(node.decimals));
      return node.decimals >= 0 ? value * factor : value / factor;
    }
    case "sum": {
      const terms = node.terms.map((t) => evaluate(t, ev));
      return terms.includes(null)
        ? null
        : (terms as bigint[]).reduce((a, b) => a + b, 0n);
    }
    case "arithmetic": {
      const pair = both(node.left, node.right);
      if (!pair) return null;
      const [l, r] = pair;
      if (node.op === "add") return l + r;
      if (node.op === "sub") return l - r;
      if (node.op === "mul") return (l * r) / SCALE;
      return r === 0n ? null : (l * SCALE) / r;
    }
  }
}

/**
 * Whether the condition holds, or null when part of it cannot be known.
 * Unknown never trips: any condition over a warming metric is false.
 */
function evaluateBool(node: BoolNode, ev: Evaluation): boolean | null {
  if (node === true) return true;
  switch (node.node) {
    case "compare": {
      const l = evaluate(node.left, ev);
      const r = evaluate(node.right, ev);
      if (l === null || r === null) return null;
      const ops = {
        eq: l === r,
        ne: l !== r,
        lt: l < r,
        le: l <= r,
        gt: l > r,
        ge: l >= r,
      };
      return ops[node.op];
    }
    case "deviation_band": {
      const v = evaluate(node.value, ev);
      const c = evaluate(node.center, ev);
      if (v === null || c === null) return null;
      const limit =
        ((c < 0n ? -c : c) * fromDecimal(node.tolerance_percent)) /
        (100n * SCALE);
      if (node.sides === "above") return v - c > limit;
      if (node.sides === "below") return c - v > limit;
      return (v > c ? v - c : c - v) > limit;
    }
    case "simulate":
      return false;
    case "and":
    case "or": {
      const terms = node.terms.map((t) => evaluateBool(t, ev));
      if (terms.includes(null)) return null;
      return node.node === "and" ? terms.every(Boolean) : terms.some(Boolean);
    }
    case "not": {
      const inner = evaluateBool(node.expr, ev);
      return inner === null ? null : !inner;
    }
  }
}

/** The block the stand-in pretends the chain is at: one every 12 seconds. */
function blockAt(clock: number): number {
  return 21_000_000 + Math.floor((clock - Date.UTC(2026, 0, 1)) / 12_000);
}

/** A document in a form where equal rules compare equal: sorted keys, lowercase addresses. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return value.toLowerCase();
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

/** What makes two rules the same watch; name, description and severity do not. */
function watchKey(rule: Rule): string {
  const { contract, when, trip_when, on_trip } = rule;
  return JSON.stringify(canonical({ contract, when, trip_when, on_trip }));
}

/** A registered contract as the stand-in keeps it. */
interface StoredContract {
  id: string;
  address: string;
  name: string;
  abi: unknown[];
  source: Contract["source"];
  implementation: Contract["implementation"];
  createdAt: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class MockEngine {
  readonly info = STAND_IN;
  #contracts = new Map<string, StoredContract>();
  #rules = new Map<string, SavedRule>();
  /** Contracts a person disabled, with the rules that switched off. */
  #disables = new Map<string, string[]>();

  // Contracts

  contracts(): Contract[] {
    return [...this.#contracts.values()]
      .map((c) => this.#summary(c))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  contract(address: string): ContractDetail | null {
    const stored = this.#contracts.get(address.toLowerCase());
    return stored ? { ...this.#summary(stored), abi: stored.abi } : null;
  }

  register(
    registration: Omit<StoredContract, "id" | "createdAt">,
  ): ContractDetail {
    const address = registration.address.toLowerCase();
    this.#contracts.set(address, {
      ...registration,
      address,
      id: `c_${randomBytes(3).toString("hex")}`,
      createdAt: new Date().toISOString(),
    });
    return this.contract(address)!;
  }

  /** Switches off every enabled rule on the contract, remembering which. */
  disable(address: string): ContractDetail | null {
    const key = address.toLowerCase();
    if (!this.#contracts.has(key)) return null;
    if (!this.#disables.has(key)) {
      const switched = this.rules(key).filter((r) => r.enabled);
      for (const rule of switched) rule.enabled = false;
      this.#disables.set(
        key,
        switched.map((r) => r.id),
      );
    }
    return this.contract(key);
  }

  /** Switches back on the rules disabling it switched off, and only those. */
  enable(address: string): ContractDetail | null {
    const key = address.toLowerCase();
    if (!this.#contracts.has(key)) return null;
    for (const id of this.#disables.get(key) ?? []) {
      const rule = this.#rules.get(id);
      if (rule) rule.enabled = true;
    }
    this.#disables.delete(key);
    return this.contract(key);
  }

  #summary(c: StoredContract): Contract {
    const rules = this.rules(c.address);
    return {
      id: c.id,
      address: c.address,
      name: c.name,
      active: !this.#disables.has(c.address),
      ruleCount: rules.length,
      enabledCount: rules.filter((r) => r.enabled).length,
      source: c.source,
      implementation: c.implementation,
      createdAt: c.createdAt,
    };
  }

  // Rules

  /** All rules, or one contract's, newest first. */
  rules(contract?: string): SavedRule[] {
    return [...this.#rules.values()]
      .filter((r) => !contract || same(r.rule.contract, contract))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  isRegistered(address: string): boolean {
    return this.#contracts.has(address.toLowerCase());
  }

  /** Evaluates the rule once at the current block, as a check before storing. */
  check(rule: Rule, clock = Date.now()): RuleCheck {
    const ev: Evaluation = {
      contract: rule.contract,
      clock,
      reads: new Map(),
      warmupSeconds: 0,
    };
    const holds = evaluateBool(rule.trip_when, ev);
    const key = watchKey(rule);
    const duplicate = this.rules().find(
      (saved) => watchKey(saved.rule) === key,
    );
    return {
      valid: true,
      issues: [],
      sentence: describeRule(rule),
      evaluation: {
        block: blockAt(clock),
        // An event rule trips on a matching log; none is at the head.
        wouldTripNow: rule.when === "every_block" && holds === true,
        reads: [...ev.reads.values()],
      },
      warmupSeconds: ev.warmupSeconds,
      duplicateOf: duplicate?.id ?? null,
      simulated: true,
    };
  }

  /** Names are unique per contract. */
  nameTaken(rule: Rule): boolean {
    return this.rules(rule.contract).some(
      (saved) => saved.rule.name === rule.name,
    );
  }

  /** Stores a rule; on a disabled contract it starts disabled, so the contract stays quiet. */
  create(rule: Rule): SavedRule {
    const saved: SavedRule = {
      id: `r_${randomBytes(3).toString("hex")}`,
      rule,
      sentence: describeRule(rule),
      enabled: !this.#disables.has(rule.contract.toLowerCase()),
      origin: "dashboard",
      createdAt: new Date().toISOString(),
    };
    this.#rules.set(saved.id, saved);
    return saved;
  }
}
