import type { Issue, Rule, Severity } from "@tripwire/shared";

// The engine's outward contract, as the application uses it: commands
// through its control interface (M6), reads from its `api_v1` views.
// Everything here is shaped like the engine's own wire and column names,
// so the stand-in and the engine are interchangeable behind it.

/** A row of `api_v1.contracts`. Ids are bigints, carried as strings. */
export interface ContractRow {
  id: string;
  address: string;
  name: string;
  abi: unknown[] | null;
  created_at: string;
  rule_count: number;
  enabled_count: number;
}

/** A row of `api_v1.rules`. */
export interface RuleRow {
  id: string;
  contract_id: string;
  contract_address: string;
  name: string;
  document: Rule;
  description: string;
  severity: Severity;
  enabled: boolean;
  origin: "app" | "mcp" | "api";
  warming: boolean;
  last_evaluated_block: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * A row of `api_v1.violations`, with the application's acknowledgement of
 * it when a person has given one.
 */
export interface ViolationRow {
  id: string;
  rule_id: string;
  rule_name: string;
  severity: Severity;
  contract_address: string;
  kind: "tripped" | "evaluation_error" | "pending";
  block_number: number;
  block_time: string;
  tx_hash: string | null;
  evidence: unknown;
  created_at: string;
  acknowledged_by: string | null;
  note: string | null;
  acknowledged_at: string | null;
}

/** `GET /v1/health`: the running process speaking for itself. */
export interface EngineHealth {
  status: "starting" | "ready" | "degraded";
  version: string;
  chain_id: number;
  /** The newest block the engine has observed. */
  head: number | null;
}

/** What evaluating a rule requires (M1 `Needs`); the application reads the warm-up. */
export interface Needs {
  warmup_seconds: number;
  [other: string]: unknown;
}

/**
 * A mirror of `trip_when` carrying each node's evaluated value: a decimal
 * string for a number, a boolean for a condition. A node that was not
 * reached is `unevaluated`; a metric without history yet is `warming`.
 */
export type Evidence = {
  node?: string;
  value?: string | boolean;
  state?: "unevaluated" | "warming";
  [child: string]: unknown;
};

/** `POST /v1/rules/dry-run` for a valid document. */
export interface DryRun {
  document: Rule;
  description: string;
  needs: Needs;
  evaluation: {
    would_trip: boolean;
    warming: boolean;
    evidence: Evidence;
  };
}

/** `POST /v1/rules`: the stored rule, canonical, with the engine's sentence. */
export interface CreatedRule {
  id: string;
  document: Rule;
  description: string;
  needs: Needs;
}

export interface ReadCall {
  address: string;
  /** Declared returns, as rules name reads: "totalSupply() returns (uint256)". */
  function: string;
  args: string[];
}

/** A refusal from the engine: its status, stable code and message. */
export class EngineError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Every problem with a rule document, when that is the refusal. */
    readonly issues?: Issue[],
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** The views have not been created yet: the engine has not initialised the database. */
export class EngineNotReady extends Error {
  constructor() {
    super("The engine has not initialised the database yet.");
    this.name = "EngineNotReady";
  }
}

/** Every change to the engine goes through these, as M6 names them. */
export interface EngineCommands {
  health(): Promise<EngineHealth>;
  registerContract(contract: {
    address: string;
    name: string;
    abi?: unknown[];
  }): Promise<ContractRow>;
  updateContract(
    address: string,
    change: { name?: string; abi?: unknown[] },
  ): Promise<ContractRow>;
  deleteContract(address: string): Promise<void>;
  createRule(rule: {
    document: Rule;
    enabled: boolean;
    origin: RuleRow["origin"];
  }): Promise<CreatedRule>;
  replaceRule(id: string, document: Rule): Promise<CreatedRule>;
  setRuleEnabled(id: string, enabled: boolean): Promise<void>;
  /** Many rules in one transaction: all switched, or none. */
  setRulesEnabled(ids: string[], enabled: boolean): Promise<void>;
  deleteRule(id: string): Promise<void>;
  dryRun(document: unknown): Promise<DryRun>;
  read(calls: ReadCall[]): Promise<(string | string[])[]>;
}

/** Every read of the engine's state comes from its views. */
export interface EngineReads {
  contracts(): Promise<ContractRow[]>;
  contract(address: string): Promise<ContractRow | null>;
  rules(filter?: { contractId?: string }): Promise<RuleRow[]>;
  rule(id: string): Promise<RuleRow | null>;
  /** Newest first; `before` pages by id, `open` leaves out acknowledged ones. */
  violations(filter?: {
    ids?: string[];
    ruleId?: string;
    contractId?: string;
    open?: boolean;
    before?: string;
    limit?: number;
  }): Promise<ViolationRow[]>;
  violation(id: string): Promise<ViolationRow | null>;
}
