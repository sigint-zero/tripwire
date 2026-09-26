import type { Rule } from "@tripwire/shared";
import {
  EngineError,
  type ContractRow,
  type CreatedRule,
  type DryRun,
  type EngineCommands,
  type EngineHealth,
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

  registerContract(contract: {
    address: string;
    name: string;
    abi?: unknown[];
  }) {
    return this.#call<ContractRow>("POST", "/v1/contracts", contract);
  }

  updateContract(address: string, change: { name?: string; abi?: unknown[] }) {
    return this.#call<ContractRow>(
      "PATCH",
      `/v1/contracts/${encodeURIComponent(address)}`,
      change,
    );
  }

  async deleteContract(address: string) {
    await this.#call("DELETE", `/v1/contracts/${encodeURIComponent(address)}`);
  }

  createRule(rule: {
    document: Rule;
    enabled: boolean;
    origin: RuleRow["origin"];
  }) {
    return this.#call<CreatedRule>("POST", "/v1/rules", rule);
  }

  replaceRule(id: string, document: Rule) {
    return this.#call<CreatedRule>("PUT", `/v1/rules/${ruleId(id)}`, {
      document,
    });
  }

  async setRuleEnabled(id: string, enabled: boolean) {
    await this.#call("PATCH", `/v1/rules/${ruleId(id)}`, { enabled });
  }

  async setRulesEnabled(ids: string[], enabled: boolean) {
    if (ids.length === 0) return;
    await this.#call("POST", "/v1/rules/enabled", { ids, enabled });
  }

  async deleteRule(id: string) {
    await this.#call("DELETE", `/v1/rules/${ruleId(id)}`);
  }

  dryRun(document: unknown) {
    return this.#call<DryRun>("POST", "/v1/rules/dry-run", { document });
  }

  async read(calls: ReadCall[]) {
    const body = await this.#call<{ values: (string | string[])[] }>(
      "POST",
      "/v1/read",
      { calls },
    );
    return body.values;
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

function ruleId(id: string) {
  if (!/^\d+$/.test(id))
    throw new EngineError(404, "not_found", "No such rule.");
  return id;
}
