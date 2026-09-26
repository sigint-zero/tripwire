import {
  isSupportedAbiType,
  type EngineInfo,
  type RuleCheck,
} from "@tripwire/shared";
import {
  ToolError,
  type Agent,
  type ContractListing,
  type ContractView,
  type McpServices,
  type RuleListing,
  type SubmitInput,
  type SubmitResult,
  type ViewFunction,
} from "@tripwire/mcp";
import { warmupSeconds } from "./engine/simulate";
import {
  EngineError,
  EngineNotReady,
  headOf,
  type ContractRow,
  type EngineCommands,
  type EngineReads,
} from "./engine/types";
import type { RuleService } from "./rule-service";
import type { AppStore } from "./store";

// What agents see and do through the MCP server, built on the same
// reads, checks and records the dashboard uses. Agents propose
// detection; every decision past that stays with a person.

const UNSUPPORTED =
  "array or tuple parameters are not available in language version 1";
/** The most no-argument views read for one contract. */
const MAX_STATE_READS = 64;
/** The most source returned in one response. */
const MAX_SOURCE_BYTES = 200_000;

interface AbiEntry {
  type?: string;
  name?: string;
  stateMutability?: string;
  inputs?: { name?: string; type: string; indexed?: boolean }[];
  outputs?: { type: string }[];
}

/** An engine that is down or still starting, in the words a tool gives. */
function unavailable(error: unknown): ToolError | null {
  if (error instanceof EngineNotReady) {
    return new ToolError("engine_unavailable", "The engine is still starting.");
  }
  if (error instanceof EngineError && error.status === 503) {
    return new ToolError("engine_unavailable", "The engine is not running.");
  }
  return null;
}

async function engine<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw unavailable(error) ?? error;
  }
}

/** A contract's ABI in the forms rules take. */
function describe(abi: unknown[]): ContractView["abi"] {
  const views: ViewFunction[] = [];
  const mutators: ContractView["abi"]["mutators"] = [];
  const events: ContractView["abi"]["events"] = [];
  for (const raw of abi) {
    const entry = raw as AbiEntry;
    if (!entry.name) continue;
    const inputs = (entry.inputs ?? []).map((p) => p.type);
    const supported = inputs.every(isSupportedAbiType);
    if (entry.type === "event") {
      const params = entry.inputs ?? [];
      const named = params.every((p) => p.name);
      const signature = `${entry.name}(${params
        .map((p) =>
          `${p.type}${p.indexed ? " indexed" : ""} ${p.name ?? ""}`.trim(),
        )
        .join(", ")})`;
      events.push({
        signature,
        ...(!supported
          ? { unsupported: UNSUPPORTED }
          : !named
            ? { unsupported: "every event parameter needs a name" }
            : {}),
      });
      continue;
    }
    if (entry.type !== "function") continue;
    const signature = `${entry.name}(${inputs.join(",")})`;
    if (entry.stateMutability === "view" || entry.stateMutability === "pure") {
      const outputs = (entry.outputs ?? []).map((o) => o.type);
      const typed = supported && outputs.every(isSupportedAbiType);
      views.push({
        signature,
        ...(typed && outputs.length > 0
          ? { call: `${signature} returns (${outputs.join(",")})` }
          : {}),
        inputs,
        outputs,
        ...(typed ? {} : { unsupported: UNSUPPORTED }),
      });
    } else {
      mutators.push({
        signature,
        inputs,
        ...(supported ? {} : { unsupported: UNSUPPORTED }),
      });
    }
  }
  return { views, mutators, events };
}

function toResult(check: RuleCheck): SubmitResult {
  return {
    valid: check.valid,
    issues: check.issues,
    sentence: check.sentence,
    evaluation: check.evaluation && {
      block: check.evaluation.block,
      would_trip_now: check.evaluation.wouldTripNow,
      warming: check.evaluation.warming,
      error: check.evaluation.error,
      reads: check.evaluation.reads,
    },
    warmup_seconds: check.warmupSeconds,
    duplicate_of: check.duplicateOf,
    ...(check.simulated ? { simulated: true } : {}),
  };
}

export class AgentServices implements McpServices {
  readonly #commands: EngineCommands;
  readonly #reads: EngineReads;
  readonly #store: AppStore;
  readonly #rules: RuleService;
  readonly #info: EngineInfo;
  readonly #clock: () => number;

  constructor(options: {
    commands: EngineCommands;
    reads: EngineReads;
    store: AppStore;
    rules: RuleService;
    info: EngineInfo;
    clock?: () => number;
  }) {
    this.#commands = options.commands;
    this.#reads = options.reads;
    this.#store = options.store;
    this.#rules = options.rules;
    this.#info = options.info;
    this.#clock = options.clock ?? Date.now;
  }

  /** A contract by its id, its address or its name, in any case. */
  async #resolve(ref: string): Promise<ContractRow> {
    const key = ref.trim().toLowerCase();
    const rows = await engine(() => this.#reads.contracts());
    const found =
      rows.find((r) => r.id === key) ??
      rows.find((r) => r.address === key) ??
      rows.find((r) => r.name.toLowerCase() === key);
    if (!found) {
      throw new ToolError(
        "not_found",
        `No registered contract matches "${ref}". Call list_contracts to see them.`,
      );
    }
    return found;
  }

  listContracts(): Promise<ContractListing[]> {
    return engine(async () => {
      const [rows, rules, disables, sources] = await Promise.all([
        this.#reads.contracts(),
        this.#reads.rules(),
        this.#store.disables(),
        this.#store.sources(),
      ]);
      const saved = await this.#rules.saved(rules);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        chain_id: this.#info.chainId,
        active: !disables.has(row.id),
        rule_count: row.rule_count,
        tripped: rules.some(
          (r, i) => r.contract_id === row.id && saved[i]!.status === "tripped",
        ),
        has_source: sources.has(row.address),
      }));
    });
  }

  async getContract(ref: string, source: string): Promise<ContractView> {
    const row = await this.#resolve(ref);
    const [disable, stored, contracts] = await Promise.all([
      this.#store.disable(row.id),
      source === "none" ? null : this.#store.source(row.address),
      this.#reads.contracts(),
    ]);
    const abi = describe(row.abi ?? []);

    // The no-argument views, read at the head through the engine.
    const readable = abi.views
      .filter((v) => v.call && v.inputs.length === 0)
      .slice(0, MAX_STATE_READS);
    let state: ContractView["state"];
    try {
      const [health, values] = await Promise.all([
        this.#commands.health(),
        this.#commands.read(
          readable.map((v) => ({
            address: row.address,
            function: v.call!,
            args: [],
          })),
        ),
      ]);
      state = {
        block: headOf(health) ?? 0,
        values: readable.map((v, i) => ({
          function: v.signature,
          value: values[i] ?? "",
          type:
            v.outputs.length === 1 ? v.outputs[0]! : `(${v.outputs.join(",")})`,
        })),
      };
      const decimals = state.values.find((v) => v.function === "decimals()");
      if (
        decimals &&
        "value" in decimals &&
        typeof decimals.value === "string"
      ) {
        state.decimals = Number(decimals.value);
      }
    } catch (error) {
      if (!unavailable(error)) throw error;
      state = { unavailable: "engine is not running" };
    }

    // What it trusts: every no-argument view returning an address.
    const linked: ContractView["linked"] = [];
    if ("values" in state) {
      for (const v of state.values) {
        if (!("value" in v) || v.type !== "address") continue;
        const address = String(v.value).toLowerCase();
        linked.push({
          function: v.function,
          address,
          registered_as:
            contracts.find((c) => c.address === address)?.id ?? null,
        });
      }
    }

    return {
      contract: {
        id: row.id,
        name: row.name,
        address: row.address,
        chain_id: this.#info.chainId,
        active: !disable,
      },
      abi,
      state,
      linked,
      source: stored ? this.#source(stored, source) : null,
    };
  }

  #source(
    stored: NonNullable<Awaited<ReturnType<AppStore["source"]>>>,
    request: string,
  ): ContractView["source"] {
    const files = stored.files.map((f) => ({
      path: f.path,
      bytes: Buffer.byteLength(f.content),
    }));
    const base = {
      verified: stored.verified,
      compiler: stored.compiler,
      files,
    };
    if (request === "list") return { ...base, content: null };
    const file = stored.files.find((f) => f.path === request);
    if (!file) {
      throw new ToolError(
        "not_found",
        `No source file "${request}". Pass source "list" to see the paths.`,
      );
    }
    const whole = Buffer.from(file.content);
    return whole.length > MAX_SOURCE_BYTES
      ? {
          ...base,
          content: whole.subarray(0, MAX_SOURCE_BYTES).toString(),
          truncated: true,
        }
      : { ...base, content: file.content };
  }

  async listRules(ref?: string): Promise<RuleListing[]> {
    const contract = ref ? await this.#resolve(ref) : null;
    return engine(async () => {
      const rows = await this.#reads.rules(
        contract ? { contractId: contract.id } : {},
      );
      const saved = await this.#rules.saved(rows);
      const now = this.#clock();
      return rows.map((row, i) => {
        const rule = saved[i]!;
        const warmup = warmupSeconds(row.document.trip_when) * 1000;
        return {
          id: row.id,
          rule: row.document,
          sentence: row.description,
          enabled: row.enabled,
          origin: rule.origin,
          status: rule.status,
          current: null,
          warmup_remaining_seconds: row.warming
            ? Math.max(
                0,
                Math.ceil((Date.parse(row.created_at) + warmup - now) / 1000),
              )
            : 0,
          open_violations: rule.openViolations,
          created_at: row.created_at,
        };
      });
    });
  }

  async submitRule(input: SubmitInput, agent: Agent): Promise<SubmitResult> {
    const document = input.rule as { contract?: unknown; on_trip?: unknown };
    if (
      typeof document.contract === "string" &&
      /^0x[0-9a-fA-F]{40}$/.test(document.contract) &&
      !(await engine(() => this.#reads.contract(document.contract as string)))
    ) {
      throw new ToolError(
        "contract_not_registered",
        "This installation does not watch that address. Ask the user to add the contract in the dashboard, then try again.",
      );
    }
    const action = (document.on_trip as { action?: unknown } | undefined)
      ?.action;
    if (action !== undefined && action !== "notify") {
      throw new ToolError(
        "response_not_allowed",
        'Agents propose detection; a person chooses the response in the dashboard. Set on_trip to { "action": "notify" }.',
      );
    }

    const verdict = await engine(() => this.#rules.check(input.rule));
    switch (verdict.status) {
      case "invalid":
        return toResult(this.#rules.invalid(verdict.issues));
      case "not_registered":
        throw new ToolError(
          "contract_not_registered",
          "This installation does not watch that address. Ask the user to add the contract in the dashboard, then try again.",
        );
      case "contract_changed":
        throw new Error("A new rule cannot change its contract.");
    }
    const result = toResult(verdict.check);
    if (verdict.nameTaken && !verdict.duplicate) {
      return {
        ...result,
        valid: false,
        issues: [
          {
            code: "name_taken",
            path: "/name",
            message: "is already used by another rule on this contract",
          },
        ],
      };
    }
    if (input.check_only || verdict.duplicate) return result;

    // The volume guard counts what this token stored in the last hour.
    const limit = await this.#store.setting("mcp.submissions_per_hour", 50);
    const recent = await this.#store.submissionsInLastHour(agent.tokenId);
    if (recent.length >= limit) {
      const resets = new Date(recent[0]!.getTime() + 3_600_000).toISOString();
      throw new ToolError(
        "rate_limited",
        `This token stored ${limit} rules in the last hour, its limit. Try again after ${resets}.`,
        { resets_at: resets },
      );
    }

    // Stored disabled and notify-only, attributed to the agent.
    const id = await engine(() => this.#rules.create(verdict, "mcp", false));
    await this.#store.recordSubmission(id, {
      id: agent.tokenId,
      label: agent.label,
    });
    if (input.display_decimals !== undefined) {
      await this.#store.setDisplay(id, {
        decimals: input.display_decimals,
        unit: null,
      });
    }
    return {
      ...result,
      id,
      stored: true,
      next: "This rule is disabled until a person enables it in the dashboard.",
    };
  }
}
