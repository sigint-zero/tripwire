import {
  describeRule,
  issuesOf,
  rule as ruleSchema,
  type Rule,
} from "@tripwire/shared";
import type pg from "pg";
import {
  blockAt,
  evaluateTrip,
  simulatedRead,
  warmupSeconds,
} from "./simulate";
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
 * The development stand-in for the engine. It answers the engine's
 * commands and keeps its state in its own schemas of the same database:
 * tables in `stub`, and views in `stub_api_v1` shaped exactly like the
 * engine's `api_v1`, so the application reads the stand-in through the
 * same queries it will use against the engine. Chain values are
 * simulated.
 */
export const STUB_VIEWS = "stub_api_v1";

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS stub;
CREATE TABLE IF NOT EXISTS stub.contracts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address text NOT NULL UNIQUE,
  name text NOT NULL,
  abi jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stub.rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id bigint NOT NULL REFERENCES stub.contracts (id) ON DELETE CASCADE,
  name text NOT NULL,
  document jsonb NOT NULL,
  description text NOT NULL,
  severity text GENERATED ALWAYS AS (document->>'severity') STORED,
  enabled boolean NOT NULL,
  origin text NOT NULL,
  warmup_seconds integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, name)
);
CREATE SCHEMA IF NOT EXISTS ${STUB_VIEWS};
CREATE OR REPLACE VIEW ${STUB_VIEWS}.contracts AS
  SELECT c.id, c.address, c.name, c.abi, c.created_at,
         (SELECT count(*) FROM stub.rules r WHERE r.contract_id = c.id) AS rule_count,
         (SELECT count(*) FROM stub.rules r WHERE r.contract_id = c.id AND r.enabled) AS enabled_count
    FROM stub.contracts c;
CREATE OR REPLACE VIEW ${STUB_VIEWS}.rules AS
  SELECT r.id, r.contract_id, c.address AS contract_address, r.name, r.document,
         r.description, r.severity, r.enabled, r.origin,
         r.enabled AND r.created_at + make_interval(secs => r.warmup_seconds) > now() AS warming,
         NULL::bigint AS last_evaluated_block,
         r.created_at, r.updated_at
    FROM stub.rules r JOIN stub.contracts c ON c.id = r.contract_id;
`;

const CONTRACT_COLUMNS = "id::text, address, name, abi, created_at";

export class StubEngine implements EngineCommands {
  readonly #pool: pg.Pool;
  readonly #clock: () => number;

  private constructor(pool: pg.Pool, clock: () => number) {
    this.#pool = pool;
    this.#clock = clock;
  }

  /** Creates the stand-in's schemas if they are not there yet. */
  static async open(
    pool: pg.Pool,
    clock: () => number = Date.now,
  ): Promise<StubEngine> {
    await pool.query(SCHEMA);
    return new StubEngine(pool, clock);
  }

  health(): Promise<EngineHealth> {
    return Promise.resolve({
      status: "ready",
      version: "stand-in",
      chain_id: 1,
      head: blockAt(this.#clock()),
    });
  }

  // Contracts

  async registerContract(contract: {
    address: string;
    name: string;
    abi?: unknown[];
  }): Promise<ContractRow> {
    const address = contract.address.toLowerCase();
    try {
      const { rows } = await this.#pool.query<ContractRow>(
        `INSERT INTO stub.contracts (address, name, abi) VALUES ($1, $2, $3)
         RETURNING ${CONTRACT_COLUMNS}, 0 AS rule_count, 0 AS enabled_count`,
        [
          address,
          contract.name,
          contract.abi ? JSON.stringify(contract.abi) : null,
        ],
      );
      return rows[0]!;
    } catch (error) {
      if (uniqueViolation(error)) {
        throw new EngineError(
          409,
          "already_registered",
          "This contract is already registered.",
        );
      }
      throw error;
    }
  }

  async updateContract(
    address: string,
    change: { name?: string; abi?: unknown[] },
  ): Promise<ContractRow> {
    const { rows } = await this.#pool.query<ContractRow>(
      `UPDATE stub.contracts
          SET name = coalesce($2, name), abi = coalesce($3::jsonb, abi)
        WHERE address = $1
        RETURNING ${CONTRACT_COLUMNS},
          (SELECT count(*)::int FROM stub.rules r WHERE r.contract_id = stub.contracts.id) AS rule_count,
          (SELECT count(*)::int FROM stub.rules r WHERE r.contract_id = stub.contracts.id AND r.enabled) AS enabled_count`,
      [
        address.toLowerCase(),
        change.name ?? null,
        change.abi ? JSON.stringify(change.abi) : null,
      ],
    );
    if (!rows[0]) throw notFound("contract");
    return rows[0];
  }

  async deleteContract(address: string): Promise<void> {
    const { rowCount } = await this.#pool.query(
      "DELETE FROM stub.contracts WHERE address = $1",
      [address.toLowerCase()],
    );
    if (!rowCount) throw notFound("contract");
  }

  // Rules

  async createRule(input: {
    document: Rule;
    enabled: boolean;
    origin: RuleRow["origin"];
  }): Promise<CreatedRule> {
    const document = validate(input.document);
    const { rows: contracts } = await this.#pool.query<{ id: string }>(
      "SELECT id::text FROM stub.contracts WHERE address = $1",
      [document.contract.toLowerCase()],
    );
    const contract = contracts[0];
    if (!contract) {
      throw new EngineError(
        400,
        "contract_not_registered",
        "The rule's contract is not registered.",
      );
    }
    const warmup = warmupSeconds(document.trip_when);
    try {
      const { rows } = await this.#pool.query<{ id: string }>(
        `INSERT INTO stub.rules
           (contract_id, name, document, description, enabled, origin, warmup_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
        [
          contract.id,
          document.name,
          JSON.stringify(document),
          describeRule(document),
          input.enabled,
          input.origin,
          warmup,
        ],
      );
      return {
        id: rows[0]!.id,
        document,
        description: describeRule(document),
        needs: { warmup_seconds: warmup },
      };
    } catch (error) {
      if (uniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async replaceRule(id: string, input: Rule): Promise<CreatedRule> {
    const document = validate(input);
    const warmup = warmupSeconds(document.trip_when);
    try {
      const { rowCount } = await this.#pool.query(
        `UPDATE stub.rules
            SET name = $2, document = $3, description = $4,
                warmup_seconds = $5, updated_at = now()
          WHERE id = $1`,
        [
          id,
          document.name,
          JSON.stringify(document),
          describeRule(document),
          warmup,
        ],
      );
      if (!rowCount) throw notFound("rule");
    } catch (error) {
      if (uniqueViolation(error)) throw nameTaken();
      throw error;
    }
    return {
      id,
      document,
      description: describeRule(document),
      needs: { warmup_seconds: warmup },
    };
  }

  async setRuleEnabled(id: string, enabled: boolean): Promise<void> {
    await this.setRulesEnabled([id], enabled);
  }

  async setRulesEnabled(ids: string[], enabled: boolean): Promise<void> {
    if (ids.length === 0) return;
    // One transaction: every rule switched, or none when one is missing.
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        "UPDATE stub.rules SET enabled = $2, updated_at = now() WHERE id = ANY($1::bigint[])",
        [[...new Set(ids)], enabled],
      );
      if (rowCount !== new Set(ids).size) {
        await client.query("ROLLBACK");
        throw notFound("rule");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteRule(id: string): Promise<void> {
    const { rowCount } = await this.#pool.query(
      "DELETE FROM stub.rules WHERE id = $1",
      [id],
    );
    if (!rowCount) throw notFound("rule");
  }

  dryRun(input: unknown): Promise<DryRun> {
    // A refusal from validate() becomes a rejection, as over the wire.
    return new Promise((resolve) => resolve(this.#dryRun(input)));
  }

  #dryRun(input: unknown): DryRun {
    const document = validate(input);
    const evaluation = evaluateTrip(
      document.trip_when,
      document.contract,
      this.#clock(),
    );
    return {
      document,
      description: describeRule(document),
      needs: { warmup_seconds: warmupSeconds(document.trip_when) },
      // An event rule trips on a matching log, and none is at the head.
      evaluation:
        document.when === "every_block"
          ? evaluation
          : { ...evaluation, would_trip: false },
    };
  }

  read(calls: ReadCall[]): Promise<string[]> {
    const clock = this.#clock();
    return Promise.resolve(
      calls.map((call) =>
        simulatedRead(call.address, call.function, 0, clock).toString(),
      ),
    );
  }
}

/** Validates as the engine does, refusing with every issue at once. */
function validate(input: unknown): Rule {
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) {
    throw new EngineError(
      400,
      "invalid_rule",
      "Invalid rule.",
      issuesOf(parsed.error),
    );
  }
  return parsed.data;
}

function uniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

function nameTaken() {
  return new EngineError(
    409,
    "name_taken",
    "Another rule on this contract has that name.",
  );
}

function notFound(what: "contract" | "rule") {
  return new EngineError(404, "not_found", `No such ${what}.`);
}
