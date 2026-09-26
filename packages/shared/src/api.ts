// Shapes the local API returns, shared by the server and the dashboard.

import type { Issue, Rule } from "./rule";

/** A verified contract's ABI. For a proxy, the implementation's ABI is merged in. */
export interface ContractAbi {
  chainId: number;
  address: string;
  name: string | null;
  abi: unknown[];
  implementation: { address: string; name: string | null } | null;
}

/**
 * How the engine is set up. An installation watches one chain, and whether
 * a trip is held for approval or sent at once is set for the installation,
 * not per rule.
 */
export interface EngineInfo {
  chainId: number;
  /** notify: no transactions; prepare: held for approval; send: sent at once. */
  responseMode: "notify" | "prepare" | "send";
  /** True while the development stand-in answers instead of the engine. */
  simulated: boolean;
}

/** The engine's verdict on a rule, before or as it is stored. */
export interface RuleCheck {
  valid: boolean;
  issues: Issue[];
  /** The rule read back as one sentence; null when it is not valid. */
  sentence: string | null;
  /** The rule evaluated once at the current block. */
  evaluation: {
    block: number;
    wouldTripNow: boolean;
    /** Every contract read the rule makes, as decimal strings. */
    reads: { call: string; value: string }[];
  } | null;
  /** How long the rule watches before it can trip: its longest window. */
  warmupSeconds: number;
  /** The id of an identical rule already on the contract, if any. */
  duplicateOf: string | null;
  simulated: boolean;
}

/** What the dashboard posts to /rules: a document, checked or stored. */
export interface RuleSubmission {
  rule: unknown;
  checkOnly?: boolean;
}

export interface StoredRuleCheck extends RuleCheck {
  id: string;
  stored: true;
}

/** A rule as the engine keeps it. */
export interface SavedRule {
  id: string;
  rule: Rule;
  sentence: string;
  enabled: boolean;
  origin: "dashboard" | "api" | { mcp: string };
  createdAt: string;
}
