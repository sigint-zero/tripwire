import type { Issue } from "@tripwire/shared";

// What the MCP tools return, in the wire's snake_case, and the service
// layer the application provides to fill them. The application owns the
// data; this package owns what an agent sees and how it is described.

/** The agent calling: the MCP token it presented. */
export interface Agent {
  tokenId: string;
  label: string;
}

export interface ContractListing {
  id: string;
  name: string;
  address: string;
  chain_id: number;
  /** False while a person has disabled the contract and its rules. */
  active: boolean;
  rule_count: number;
  /** Some rule on it recorded a violation at the last block it evaluated. */
  tripped: boolean;
  has_source: boolean;
}

export interface ViewFunction {
  /** Bare positional signature, as `on_trip` and `simulate` calls take it. */
  signature: string;
  /** The declared form a `view_call` takes, when it can: "f() returns (uint256)". */
  call?: string;
  inputs: string[];
  outputs: string[];
  unsupported?: string;
}

export interface ContractView {
  contract: {
    id: string;
    name: string;
    address: string;
    chain_id: number;
    active: boolean;
  };
  abi: {
    views: ViewFunction[];
    mutators: { signature: string; inputs: string[]; unsupported?: string }[];
    events: { signature: string; unsupported?: string }[];
  };
  state:
    | {
        block: number;
        values: (
          | { function: string; value: string | string[]; type: string }
          | { function: string; error: string }
        )[];
        decimals?: number;
      }
    | { unavailable: string };
  linked: { function: string; address: string; registered_as: string | null }[];
  source: {
    verified: boolean;
    compiler: string | null;
    files: { path: string; bytes: number }[];
    content: string | null;
    truncated?: boolean;
  } | null;
}

export interface RuleListing {
  id: string;
  rule: unknown;
  sentence: string;
  enabled: boolean;
  origin: "dashboard" | "api" | { mcp: string };
  /** As every other surface shows it. */
  status: "off" | "tripped" | "error" | "warming" | "holding";
  current: { series: string; value: string; block: number } | null;
  warmup_remaining_seconds: number;
  /** Violations nobody has acknowledged. */
  open_violations: number;
  created_at: string;
}

export interface SubmitResult {
  valid: boolean;
  issues: Issue[];
  sentence: string | null;
  evaluation: {
    block: number;
    would_trip_now: boolean;
    /** A metric cannot be judged yet: not the same as would not trip. */
    warming: boolean;
    /** The node the engine could not evaluate, and why; such a rule never fires. */
    error: { path: string; message: string } | null;
    reads: { call: string; value: string }[];
  } | null;
  warmup_seconds: number;
  duplicate_of: string | null;
  simulated?: boolean;
  id?: string;
  stored?: true;
  next?: string;
}

export interface SubmitInput {
  rule: unknown;
  display_decimals?: number;
  check_only?: boolean;
}

export type ToolErrorCode =
  | "contract_not_registered"
  | "response_not_allowed"
  | "invalid_rule"
  | "duplicate"
  | "engine_unavailable"
  | "rate_limited"
  | "not_found";

/** A refusal the model can act on: a stable code, a sentence, and details. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** The application, as the tools reach it. Refusals are thrown as ToolError. */
export interface McpServices {
  listContracts(): Promise<ContractListing[]>;
  /** `contract` is an id, an address or a name; `source` is none, list or a path. */
  getContract(contract: string, source: string): Promise<ContractView>;
  /** Every rule, or those on one contract. */
  listRules(contract?: string): Promise<RuleListing[]>;
  submitRule(input: SubmitInput, agent: Agent): Promise<SubmitResult>;
}
