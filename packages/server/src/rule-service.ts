import {
  issuesOf,
  rule as ruleSchema,
  shortSignature,
  type Issue,
  type Rule,
  type RuleCheck,
  type SavedRule,
} from "@tripwire/shared";
import {
  EngineError,
  type ContractRow,
  type DryRun,
  type EngineCommands,
  type EngineReads,
  type Evidence,
  type RuleRow,
} from "./engine/types";
import type { AppStore, Display } from "./store";

// How a rule document becomes a stored rule, whoever submits it: the
// dashboard through the API, or an agent through the MCP server. Both
// get the same checks, in the same order.

const NO_DISPLAY: Display = { decimals: null, unit: null };

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
function watchKey(document: Rule): string {
  const { contract, when, trip_when, on_trip } = document;
  return JSON.stringify(canonical({ contract, when, trip_when, on_trip }));
}

/** Every contract read in the evidence, with the value the engine saw. */
function readsOf(evidence: unknown): { call: string; value: string }[] {
  const found = new Map<string, string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const e = node as Evidence & {
      function?: string;
      returns?: number;
      address?: string;
    };
    if (e.node === "view_call" && typeof e.value === "string" && e.function) {
      const short = shortSignature(e.function);
      const call = e.returns === undefined ? short : `${short}[${e.returns}]`;
      found.set(e.address ? `${call} of ${e.address}` : call, e.value);
    }
    Object.values(node).forEach(walk);
  };
  walk(evidence);
  return [...found].map(([call, value]) => ({ call, value }));
}

function toCheck(
  dry: DryRun,
  block: number,
  duplicateOf: string | null,
  simulated: boolean,
): RuleCheck {
  return {
    valid: true,
    issues: [],
    sentence: dry.description,
    evaluation: {
      block,
      wouldTripNow: dry.evaluation.would_trip,
      reads: readsOf(dry.evaluation.evidence),
    },
    warmupSeconds: dry.needs.warmup_seconds,
    duplicateOf,
    simulated,
  };
}

function toSaved(
  row: RuleRow,
  submitters: Map<string, string>,
  displays: Map<string, Display>,
): SavedRule {
  return {
    id: row.id,
    rule: row.document,
    sentence: row.description,
    enabled: row.enabled,
    origin:
      row.origin === "app"
        ? "dashboard"
        : row.origin === "mcp"
          ? { mcp: submitters.get(row.id) ?? "agent" }
          : "api",
    warming: row.warming,
    lastEvaluatedBlock: row.last_evaluated_block,
    display: displays.get(row.id) ?? NO_DISPLAY,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The engine's verdict on a document, with what storing it would clash with. */
export interface Checked {
  status: "checked";
  document: Rule;
  contract: ContractRow;
  check: RuleCheck;
  /** An identical rule already on the contract. */
  duplicate?: RuleRow;
  /** Another rule on the contract has the document's name. */
  nameTaken: boolean;
}

export type Verdict =
  | { status: "invalid"; issues: Issue[] }
  | { status: "not_registered" }
  | { status: "contract_changed" }
  | Checked;

export class RuleService {
  readonly #commands: EngineCommands;
  readonly #reads: EngineReads;
  readonly #store: AppStore;
  readonly simulated: boolean;

  constructor(
    commands: EngineCommands,
    reads: EngineReads,
    store: AppStore,
    simulated: boolean,
  ) {
    this.#commands = commands;
    this.#reads = reads;
    this.#store = store;
    this.simulated = simulated;
  }

  /** A check that found the document invalid, in the shape of any other. */
  invalid(issues: Issue[]): RuleCheck {
    return {
      valid: false,
      issues,
      sentence: null,
      evaluation: null,
      warmupSeconds: 0,
      duplicateOf: null,
      simulated: this.simulated,
    };
  }

  /**
   * Validates a document, evaluates it once at the head and compares it
   * with the rules already on its contract. When `replacing` names a
   * rule, that rule is not its own duplicate, and the contract must stay.
   */
  async check(input: unknown, replacing?: RuleRow): Promise<Verdict> {
    const parsed = ruleSchema.safeParse(input);
    if (!parsed.success) {
      return { status: "invalid", issues: issuesOf(parsed.error) };
    }
    const document = parsed.data;
    if (
      replacing &&
      document.contract.toLowerCase() !== replacing.contract_address
    ) {
      return { status: "contract_changed" };
    }
    const contract = await this.#reads.contract(document.contract);
    if (!contract) return { status: "not_registered" };

    let dry: DryRun;
    try {
      dry = await this.#commands.dryRun(document);
    } catch (error) {
      if (error instanceof EngineError && error.issues) {
        return { status: "invalid", issues: error.issues };
      }
      throw error;
    }
    const [health, existing] = await Promise.all([
      this.#commands.health(),
      this.#reads.rules({ contractId: contract.id }),
    ]);
    const others = existing.filter((r) => r.id !== replacing?.id);
    const key = watchKey(dry.document);
    const duplicate = others.find((r) => watchKey(r.document) === key);
    return {
      status: "checked",
      document: dry.document,
      contract,
      check: toCheck(
        dry,
        health.head ?? 0,
        duplicate?.id ?? null,
        this.simulated,
      ),
      duplicate,
      nameTaken: others.some((r) => r.name === dry.document.name),
    };
  }

  /** Stores a checked document as a new rule. */
  async create(
    checked: Checked,
    origin: RuleRow["origin"],
    enabled: boolean,
  ): Promise<string> {
    const created = await this.#commands.createRule({
      document: checked.document,
      enabled,
      origin,
    });
    return created.id;
  }

  /** Rules as the API shows them, with who submitted them and their display. */
  async saved(rows: RuleRow[]): Promise<SavedRule[]> {
    const [submitters, displays] = await Promise.all([
      this.#store.submitters(
        rows.filter((r) => r.origin === "mcp").map((r) => r.id),
      ),
      this.#store.displays(rows.map((r) => r.id)),
    ]);
    return rows.map((row) => toSaved(row, submitters, displays));
  }
}
