import type { Rule } from "@tripwire/shared";
import {
  EngineError,
  type ContractRow,
  type CreatedRule,
  type DryRun,
  type EngineCommands,
  type EngineHealth,
  type KeyChange,
  type KeyRow,
  type ReadCall,
  type RuleRow,
} from "./types";

/**
 * The engine's control interface over HTTP (M6): loopback only, every
 * request carrying the interface secret the engine wrote to its data
 * directory.
 */
export class HttpEngine implements EngineCommands {
  readonly #base: string;
  readonly #secret: string;

  constructor(options: { url: string; secret: string }) {
    this.#base = options.url.replace(/\/+$/, "");
    this.#secret = options.secret.trim();
  }

  health() {
    return this.#call<EngineHealth>("GET", "/v1/health");
  }

  async registerContract(contract: {
    address: string;
    name: string;
    abi?: unknown[];
  }) {
    return toContract(
      await this.#call<WireContract>("POST", "/v1/contracts", contract),
    );
  }

  async updateContract(
    address: string,
    change: { name?: string; abi?: unknown[] },
  ) {
    return toContract(
      await this.#call<WireContract>(
        "PATCH",
        `/v1/contracts/${encodeURIComponent(address)}`,
        change,
      ),
    );
  }

  async deleteContract(address: string) {
    await this.#call("DELETE", `/v1/contracts/${encodeURIComponent(address)}`);
  }

  async createRule(rule: {
    document: Rule;
    enabled: boolean;
    origin: RuleRow["origin"];
  }) {
    return toCreated(await this.#call<WireRule>("POST", "/v1/rules", rule));
  }

  async replaceRule(id: string, document: Rule) {
    return toCreated(
      await this.#call<WireRule>("PUT", `/v1/rules/${ruleId(id)}`, {
        document,
      }),
    );
  }

  async setRuleEnabled(id: string, enabled: boolean) {
    await this.#call("PATCH", `/v1/rules/${ruleId(id)}`, { enabled });
  }

  async setRulesEnabled(ids: string[], enabled: boolean) {
    if (ids.length === 0) return;
    // Ids are integers on the wire.
    await this.#call("POST", "/v1/rules/enabled", {
      ids: ids.map((id) => Number(ruleId(id))),
      enabled,
    });
  }

  async deleteRule(id: string) {
    await this.#call("DELETE", `/v1/rules/${ruleId(id)}`);
  }

  dryRun(document: unknown) {
    return this.#call<DryRun>("POST", "/v1/rules/dry-run", { document });
  }

  async read(calls: ReadCall[]) {
    const body = await this.#call<{
      results: { values?: unknown[] | null; error?: string | null }[];
    }>("POST", "/v1/read", { calls });
    return body.results.map((result) => {
      if (!result.values) return null;
      const values = result.values.map(scalar);
      return values.length === 1 ? values[0]! : values;
    });
  }

  async approveResponse(id: string) {
    await this.#call("POST", `/v1/responses/${responseId(id)}/approve`);
  }

  async rejectResponse(id: string, reason: string | null) {
    await this.#call(
      "POST",
      `/v1/responses/${responseId(id)}/reject`,
      reason ? { reason } : {},
    );
  }

  keys() {
    return this.#call<KeyRow[]>("GET", "/v1/keys");
  }

  createKey(passphrase: string) {
    return this.#call<KeyChange>("POST", "/v1/keys", { passphrase });
  }

  importKey(keystore: object, passphrase: string) {
    return this.#call<KeyChange>("POST", "/v1/keys/import", {
      keystore,
      passphrase,
    });
  }

  unlockKey(address: string, passphrase: string) {
    return this.#call<KeyChange>(
      "POST",
      `/v1/keys/${encodeURIComponent(address)}/unlock`,
      { passphrase },
    );
  }

  lockKey(address: string) {
    return this.#call<KeyChange>(
      "POST",
      `/v1/keys/${encodeURIComponent(address)}/lock`,
    );
  }

  async #call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#secret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new EngineError(
        503,
        "engine_unreachable",
        `The engine is not answering: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const failure = (parsed ?? {}) as {
        error?: { code?: string; message?: string };
        issues?: EngineError["issues"];
      };
      throw new EngineError(
        response.status,
        failure.error?.code ?? "engine_error",
        failure.error?.message ?? `The engine answered ${response.status}.`,
        failure.issues,
      );
    }
    return parsed as T;
  }
}

/** `ContractResponse`: the stored contract, without the view's counts. */
interface WireContract {
  id: number;
  address: string;
  name: string;
  abi: unknown[] | null;
  created_at: string;
}

/** `RuleResponse`, as far as the application reads it. */
interface WireRule {
  id: number;
  document: Rule;
  description: string;
  needs: CreatedRule["needs"];
}

function toContract(wire: WireContract): ContractRow {
  // The counts are the view's; a contract the engine just stored has none.
  return {
    ...wire,
    id: String(wire.id),
    created_at: new Date(wire.created_at).toISOString(),
    rule_count: 0,
    enabled_count: 0,
  };
}

function toCreated(wire: WireRule): CreatedRule {
  return {
    id: String(wire.id),
    document: wire.document,
    description: wire.description,
    needs: wire.needs,
  };
}

/** A decoded return component as text: tuples joined, anything else as written. */
function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `(${value.map(scalar).join(",")})`;
  return JSON.stringify(value);
}

function responseId(id: string) {
  if (!/^\d+$/.test(id))
    throw new EngineError(404, "not_found", "No such response.");
  return id;
}

function ruleId(id: string) {
  if (!/^\d+$/.test(id))
    throw new EngineError(404, "not_found", "No such rule.");
  return id;
}
