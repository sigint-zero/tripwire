import type {
  Issue,
  ResponseStatus,
  Rule,
  Severity,
  ViolationKind,
} from "@tripwire/shared";

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
  response_id: string | null;
  response_status: ResponseStatus | null;
}

/** A row of the `series` view: one recorded read, or a metric over one. */
export interface SeriesRow {
  id: string;
  key: string;
  address: string;
  function: string;
  args: string[];
  returns: number | null;
  metric: string | null;
  window_seconds: number | null;
}

/** A series a rule draws from, as `rule_series` links them, with where in the document. */
export interface RuleSeriesRow extends SeriesRow {
  rule_id: string;
  /** `read` for a recorded read, `metric` for the base a metric samples. */
  role: "read" | "metric";
  /** A JSON pointer to the node in the rule's document. */
  path: string;
}

/** A rule's newest violation and how many nobody has acknowledged. */
export interface RuleActivity {
  rule_id: string;
  newest_kind: ViolationKind | null;
  newest_block: number | null;
  open_count: number;
}

export interface PointRow {
  series_id: string;
  block_number: number;
  block_time: string;
  value: string;
}

export interface BucketRow {
  series_id: string;
  bucket: number;
  first: string;
  last: string;
  min: string;
  max: string;
  count: number;
}

/** A row of the `responses` view, with its violation and contract. */
export interface ResponseRow {
  id: string;
  violation_id: string;
  rule_id: string;
  rule_name: string;
  contract_address: string;
  contract_name: string | null;
  action: string;
  mode: string;
  status: ResponseStatus;
  /** The built transaction, as the engine keeps it. */
  tx: unknown;
  error: string | null;
  created_at: string;
  updated_at: string;
  violation_kind: ViolationKind | null;
  violation_block: number | null;
}

/** `GET /v1/health`: the running process speaking for itself. */
export interface EngineHealth {
  status: "starting" | "ready" | "degraded";
  version: string;
  chain_id: number;
  /** The head the follower last observed on the node. */
  observed_head: number | null;
  /** The last block the evaluator committed. */
  evaluated_block: number | null;
  /** Where each cursor stands, and how long since it moved. */
  cursors: {
    name: string;
    block_number: number;
    block_hash: string;
    age_seconds: number;
  }[];
  rpc: {
    /** `ok`, `failing`, or `unknown` before the first poll. */
    state: string;
    observed_head: number | null;
    last_success_unix_ms: number | null;
    last_failure_unix_ms: number | null;
  };
  /** The mirrored TripwireController; absent when none is configured, or while starting. */
  controller?: { address: string; mirrored_block?: number | null } | null;
  /** The signer summary; absent while starting. */
  keys?: { known: number; unlocked: number } | null;
  /** What degrades the engine, when something does. */
  cause?: string | null;
}

/** The block the engine's answers are true at: the last it evaluated. */
export function headOf(health: EngineHealth): number | null {
  return health.evaluated_block ?? health.observed_head;
}

/** A tripped row of `api_v1.trip_state`, for a registered contract. */
export interface TripStateRow {
  contract_address: string;
  contract_name: string;
  abi: unknown[] | null;
  /** `''` for the whole contract, else the paused function's selector. */
  selector: string;
  /** `controller` for the controller's pause, `verify` for a confirmed call. */
  source: "controller" | "verify";
  since_block: number;
  tx_hash: string | null;
}

/** An operator the controller names on a registered contract, from its events. */
export interface OperatorRow {
  /** The contract as registered. */
  contract_address: string;
  /** Lowercase `0x` address. */
  operator: string;
}

/** A registered contract that registered itself with the controller, and its guardian now. */
export interface RegistrationRow {
  /** The contract as registered with Tripwire. */
  contract_address: string;
  /** Lowercase `0x` address. */
  guardian: string;
}

/** `KeyOut`: a keystore on disk, whether it can sign, and its native balance. */
export interface KeyRow {
  /** Lowercase `0x` address. */
  address: string;
  unlocked: boolean;
  /** Wei, as a decimal string. */
  balance: string;
}

/** `KeyAddress`: a key after a change. */
export interface KeyChange {
  address: string;
  unlocked: boolean;
}

/** A row of `api_v1.engine_status`: one cursor, as the engine last recorded it. */
export interface CursorRow {
  cursor: string;
  block_number: string;
  updated_at: Date;
  engine_version: string | null;
}

/** What evaluating a rule requires (M1 `Needs`); the application reads the warm-up. */
export interface Needs {
  warmup_seconds: number;
  [other: string]: unknown;
}

/**
 * A mirror of `trip_when` carrying each node's evaluated value: a decimal
 * string for a number, a boolean for a condition. A term that was not
 * reached is only `{ unevaluated: true }`; a value that cannot be known
 * yet, a metric without history, is marked `warming`.
 */
export type Evidence = {
  node?: string;
  value?: string | boolean;
  unevaluated?: true;
  warming?: true;
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
    /** Null when the rule could not be judged; `error` says why. */
    evidence: Evidence | null;
    /** The failing node's path and what happened. */
    error?: { path?: string; message?: string } | null;
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
  /** Each call's value, its components for several, or null when it failed. */
  read(calls: ReadCall[]): Promise<(string | string[] | null)[]>;
  /** Sends a held response; `409` when it is no longer waiting. */
  approveResponse(id: string): Promise<void>;
  /** Abandons a held response; `409` when it is no longer waiting. */
  rejectResponse(id: string, reason: string | null): Promise<void>;
  keys(): Promise<KeyRow[]>;
  /** Generates a key in the engine; it starts unlocked. */
  createKey(passphrase: string): Promise<KeyChange>;
  /** Stores a keystore made elsewhere, once it opens; it starts locked. */
  importKey(keystore: object, passphrase: string): Promise<KeyChange>;
  /** `400 wrong_passphrase` naming nothing further; `404` for an unknown key. */
  unlockKey(address: string, passphrase: string): Promise<KeyChange>;
  lockKey(address: string): Promise<KeyChange>;
}

/** Every read of the engine's state comes from its views. */
export interface EngineReads {
  /** The schema the views are read from: `api_v1`, or the stand-in's copy. */
  readonly views: string;
  contracts(): Promise<ContractRow[]>;
  contract(address: string): Promise<ContractRow | null>;
  rules(filter?: { contractId?: string }): Promise<RuleRow[]>;
  rule(id: string): Promise<RuleRow | null>;
  /** Newest first; `before` pages by id, `open` leaves out acknowledged ones. */
  violations(filter?: {
    ids?: string[];
    ruleId?: string;
    kind?: ViolationKind;
    contractId?: string;
    open?: boolean;
    before?: string;
    limit?: number;
  }): Promise<ViolationRow[]>;
  violation(id: string): Promise<ViolationRow | null>;
  /** Newest first; `before` pages by id. */
  responses(filter?: {
    statuses?: ResponseStatus[];
    contractAddress?: string;
    before?: string;
    limit?: number;
  }): Promise<ResponseRow[]>;
  response(id: string): Promise<ResponseRow | null>;
  responseCounts(): Promise<{ waiting: number; inFlight: number }>;
  /** What is paused now, on registered contracts. */
  tripState(): Promise<TripStateRow[]>;
  /** Where the engine's cursors stand; readable while the engine is down. */
  engineStatus(): Promise<CursorRow[]>;
  /** Operators granted on registered contracts and not since removed. */
  operators(): Promise<OperatorRow[]>;
  /** Registered contracts on the controller, each with its latest guardian. */
  registrations(): Promise<RegistrationRow[]>;
  /** Each rule's newest violation and open count, in one bounded read. */
  ruleActivity(ruleIds: string[]): Promise<RuleActivity[]>;
  /** The series each rule draws from, in document order. */
  ruleSeries(ruleIds: string[]): Promise<RuleSeriesRow[]>;
  seriesById(id: string): Promise<SeriesRow | null>;
  /** The newest point of each series. */
  newestPoints(seriesIds: string[]): Promise<PointRow[]>;
  /** How many raw points and rollups fall in the range. */
  countPoints(
    seriesId: string,
    from: Date,
    to: Date,
  ): Promise<{ raw: number; rollups: number }>;
  points(
    seriesId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<PointRow[]>;
  /**
   * The range cut into `buckets` equal stretches per series, from raw
   * points and rollups alike, each with first, last, min, max and count.
   */
  buckets(
    seriesIds: string[],
    from: Date,
    to: Date,
    buckets: number,
  ): Promise<BucketRow[]>;
}
