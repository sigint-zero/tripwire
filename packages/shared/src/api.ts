// Shapes the local API returns, shared by the server and the dashboard.

import type { Issue, Rule, Severity } from "./rule";

/** A verified contract's ABI. For a proxy, the implementation's ABI is merged in. */
export interface ContractAbi {
  chainId: number;
  address: string;
  name: string | null;
  abi: unknown[];
  implementation: { address: string; name: string | null } | null;
}

/** A contract registered for Tripwire to watch. */
export interface Contract {
  id: string;
  /** Lowercase; an installation watches one chain, so the address is the key. */
  address: string;
  name: string;
  /** False while a person has disabled it and its rules with it. */
  active: boolean;
  ruleCount: number;
  enabledCount: number;
  /** Where the ABI came from: the verified source, or pasted by a person. */
  source: "verified" | "pasted";
  implementation: { address: string; name: string | null } | null;
  createdAt: string;
}

export interface ContractDetail extends Contract {
  abi: unknown[];
}

/** Registering a contract; without an ABI the verified one is looked up. */
export interface ContractRegistration {
  address: string;
  name: string;
  abi?: unknown[];
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

/**
 * What the dashboard posts to /rules, or puts to /rules/:id to replace a
 * rule's document: checked only, or checked and stored.
 */
export interface RuleSubmission {
  rule: unknown;
  checkOnly?: boolean;
}

export interface StoredRuleCheck extends RuleCheck {
  id: string;
  stored: true;
  /** False when the rule's contract is disabled: it starts disabled too. */
  enabled: boolean;
}

/** How a rule's values are shown: divided by 10^decimals, then the unit. */
export interface RuleDisplay {
  decimals: number | null;
  unit: string | null;
}

/** A rule as the engine keeps it. */
export interface SavedRule {
  id: string;
  rule: Rule;
  sentence: string;
  enabled: boolean;
  origin: "dashboard" | "api" | { mcp: string };
  /** True while a metric the rule reads is still gathering its window. */
  warming: boolean;
  lastEvaluatedBlock: number | null;
  display: RuleDisplay;
  createdAt: string;
  updatedAt: string;
}

/** Changing a stored rule: switching it, or how it is shown. */
export interface RuleChange {
  enabled?: boolean;
  display?: RuleDisplay;
}

export type ViolationKind = "tripped" | "evaluation_error" | "pending";

/** A rule tripping, or failing to evaluate, at one block. */
export interface Violation {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  contractAddress: string;
  kind: ViolationKind;
  blockNumber: number;
  blockTime: string;
  txHash: string | null;
  /** The condition with every value the evaluation saw, or the error. */
  evidence: unknown;
  createdAt: string;
  acknowledged: { by: string; note: string | null; at: string } | null;
}

/** The logged-in account and its session. */
export interface AccountSession {
  user: { id: string; username: string };
  createdAt: string;
  /** Sessions end a day after login, however busy. */
  expiresAt: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  address: string;
  userAgent: string;
  /** The session making this request. */
  current: boolean;
}

export interface AccountSummary {
  id: string;
  username: string;
  createdAt: string;
}

/** An AI agent's MCP token, without the token, which is shown only once. */
export interface McpTokenSummary {
  id: string;
  label: string;
  owner: { id: string; username: string } | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}
