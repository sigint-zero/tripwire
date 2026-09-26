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
  /**
   * Its registration with the TripwireController, seen in the controller's
   * events, and its guardian now; null when it did not register.
   */
  controller: { guardian: string } | null;
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

/** Where the engine is, as the application sees it; `ready` and `degraded` are protecting. */
export type EngineState =
  | "unconfigured"
  | "installing"
  | "starting"
  | "ready"
  | "degraded"
  | "unresponsive"
  | "restarting"
  | "failed"
  | "stopped"
  | "stand-in";

/**
 * The engine's last health answer. While it is down, the head and cursors
 * come from what it last recorded, and the rest is null.
 */
export interface EngineHealth {
  head: number | null;
  /** When the head block was made, or when it was processed where that is all that is known. */
  headTime: string | null;
  /** The head minus the ingest cursor. */
  lagBlocks: number | null;
  /** The RPC's state in the engine's words, such as "ok" or "retrying". */
  rpc: string | null;
  cursors: { name: string; block: number; ageSeconds: number }[];
  /** The TripwireController the engine mirrors, when one is configured. */
  controller: { address: string; mirroredBlock: number | null } | null;
  /** The engine's signing keys: how many exist, and how many can sign now. */
  keys: { known: number; unlocked: number } | null;
}

/** `GET /engine`: how it is set up, and whether it is watching. */
export interface EngineStatus extends EngineInfo {
  state: EngineState;
  /** When it entered this state. */
  since: string;
  /** Who runs it: the application, someone by hand, or the stand-in. */
  runner: "supervised" | "attached" | "stand-in";
  version: string | null;
  pinnedVersion: string | null;
  unpinned: boolean;
  /** The download's progress while installing. */
  install: { bytes: number; total: number | null } | null;
  health: EngineHealth | null;
  restarts: { last10Minutes: number; total: number };
  lastExit: {
    code: number | null;
    signal: string | null;
    at: string;
    reason: string;
  } | null;
  /** While failed, restarting or unresponsive: the engine's own message where it gave one. */
  problem: { code: string; message: string } | null;
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
    /** A metric cannot be judged yet: not the same as would not trip. */
    warming: boolean;
    /** The node the engine could not evaluate, and why; a rule that cannot be evaluated never fires. */
    error: EvaluationError | null;
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

/** Where a rule stands now; `RULES.md` defines each. */
export type RuleStatus = "off" | "tripped" | "error" | "warming" | "holding";

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
  status: RuleStatus;
  /** Violations nobody has acknowledged. */
  openViolations: number;
}

/** A contract read the engine records a value of at every block. */
export interface RuleSeries {
  id: string;
  call: {
    address: string;
    function: string;
    args: string[];
    returns: number | null;
  };
  metric: string | null;
  windowSeconds: number | null;
  /** `read` for a contract read, `metric` for a value computed over one. */
  role: "read" | "metric";
}

/** A series' newest value. */
export interface CurrentValue {
  seriesId: string;
  value: string;
  blockNumber: number;
  blockTime: string;
}

export interface SeriesPoint {
  blockNumber: number;
  blockTime: string;
  value: string;
}

/** A stretch of time summarised: the spike inside it survives in min and max. */
export interface SeriesBucket {
  start: string;
  first: string;
  last: string;
  min: string;
  max: string;
  count: number;
}

/** A window of a series: its points when few, else buckets. */
export type SeriesWindow =
  | { resolution: "block"; points: SeriesPoint[] }
  | { resolution: string; buckets: SeriesBucket[] };

/** A rule's first series over a day, for the list and the Overview. */
export interface Sparkline {
  ruleId: string;
  seriesId: string;
  buckets: SeriesBucket[];
}

/** Where the engine could not evaluate a rule, and what happened. */
export interface EvaluationError {
  /** The failing node's JSON pointer in the document. */
  path: string;
  message: string;
}

/** One evaluation of a stored rule at the current block; nothing is recorded. */
export interface CheckNow {
  /** The engine's last evaluated block; null before it has seen one. */
  block: number | null;
  wouldTripNow: boolean;
  warming: boolean;
  warmupSecondsLeft: number;
  evaluationError: EvaluationError | null;
  evidence: unknown;
}

/** Changing a stored rule: switching it, or how it is shown. */
export interface RuleChange {
  enabled?: boolean;
  display?: RuleDisplay;
}

/** Where a response stands, from built to final. */
export type ResponseStatus =
  | "pending"
  | "awaiting_approval"
  | "approved"
  | "submitted"
  | "confirmed"
  | "failed"
  | "abandoned";

export type ViolationKind = "tripped" | "evaluation_error" | "pending";

/** The Responses page's tabs, each a set of statuses. */
export type ResponseTab = "waiting" | "in_flight" | "history";

/** One submission of a response's transaction. */
export interface ResponseAttempt {
  hash: string;
  maxFeeGwei: string | null;
  maxPriorityFeeGwei: string | null;
  block: number | null;
}

/** The transaction the engine built: what a person approves is what is sent. */
export interface ResponseTx {
  to: string | null;
  /** The signing key. */
  from: string | null;
  function: string | null;
  args: string[];
  value: string;
  nonce: number | null;
  gasLimit: string | null;
  maxFeeGwei: string | null;
  maxPriorityFeeGwei: string | null;
  /** The most it can cost at the fee caps. */
  maxCostWei: string | null;
  hash: string | null;
  /** Rebuilt and re-signed at approval because the chain moved. */
  rebuilt: boolean;
  attempts: ResponseAttempt[];
  /** Where it was confirmed, and the gas it used. */
  block: number | null;
  gasUsed: string | null;
}

/** What the engine does about one violation whose rule acts on chain. */
export interface ResponseItem {
  id: string;
  status: ResponseStatus;
  action: "trip_global" | "trip_function" | "call";
  mode: "prepare" | "send";
  rule: { id: string; name: string };
  contract: { address: string; name: string | null };
  violation: { id: string; kind: ViolationKind; blockNumber: number } | null;
  tx: ResponseTx | null;
  /** Why it failed or was abandoned, or the problem holding it. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResponseCounts {
  waiting: number;
  inFlight: number;
}

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
  /** What the engine did about it on chain; null when it did nothing. */
  response: { id: string; status: ResponseStatus } | null;
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

/** `GET /trip-state`: something paused now on a registered contract. */
export interface TripStateItem {
  contract: { address: string; name: string };
  scope: "global" | "function";
  /** The paused function's selector; null for the whole contract. */
  selector: string | null;
  /** The function's signature, when the contract's ABI names it. */
  function: string | null;
  /** `controller` for the controller's pause, `verify` for a call whose confirmation holds. */
  source: "controller" | "verify";
  sinceBlock: number;
  /** The block's time, once the view carries it. */
  sinceTime: string | null;
  /** The pausing transaction; none for a confirmed call, whose state is observed. */
  txHash: string | null;
  /** Who sent it, when that is known: Tripwire's own response. */
  actor: {
    address: string | null;
    is: "tripwire_response";
    responseId: string;
    rule: { id: string; name: string };
  } | null;
  /** For a confirmed call: the rules whose confirmation reads true. */
  rules: { id: string; name: string }[];
}

/** `GET /setup`: which first-run steps are done, and whether the checklist was dismissed. */
export interface SetupState {
  steps: {
    account: boolean;
    chain: boolean;
    contract: boolean;
    rule: boolean;
    channel: boolean;
  };
  dismissed: boolean;
}
