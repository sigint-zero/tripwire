import {
  describeRule,
  type EngineInfo,
  issuesOf,
  parseSignature,
  rule as ruleSchema,
  type Rule,
} from "@tripwire/shared";
import type pg from "pg";
import type { EngineEvents, EngineListener } from "../events/types";
import {
  actsOnChain,
  buildTx,
  confirmed,
  DEFAULT_QUIET_SECONDS,
  submitted,
  type StubTx,
} from "./stub-responses";
import {
  blockAt,
  evaluateTrip,
  simulatedValue,
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
ALTER TABLE stub.rules ADD COLUMN IF NOT EXISTS last_evaluated_block bigint;
CREATE TABLE IF NOT EXISTS stub.violations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id bigint NOT NULL REFERENCES stub.rules (id) ON DELETE CASCADE,
  kind text NOT NULL,
  block_number bigint NOT NULL,
  block_time timestamptz NOT NULL,
  tx_hash text,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stub.responses (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  violation_id bigint NOT NULL REFERENCES stub.violations (id) ON DELETE CASCADE,
  action text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  tx jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
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
         r.last_evaluated_block,
         r.created_at, r.updated_at
    FROM stub.rules r JOIN stub.contracts c ON c.id = r.contract_id;
CREATE OR REPLACE VIEW ${STUB_VIEWS}.violations AS
  SELECT v.id, v.rule_id, r.name AS rule_name, r.severity,
         c.address AS contract_address, v.kind, v.block_number, v.block_time,
         v.tx_hash, v.evidence, v.created_at
    FROM stub.violations v
    JOIN stub.rules r ON r.id = v.rule_id
    JOIN stub.contracts c ON c.id = r.contract_id;
CREATE OR REPLACE VIEW ${STUB_VIEWS}.responses AS
  SELECT p.id, p.violation_id, v.rule_id, r.name AS rule_name,
         c.address AS contract_address, p.action, p.mode, p.status, p.tx,
         p.error, p.created_at, p.updated_at
    FROM stub.responses p
    JOIN stub.violations v ON v.id = p.violation_id
    JOIN stub.rules r ON r.id = v.rule_id
    JOIN stub.contracts c ON c.id = r.contract_id;
`;

type ResponseMode = EngineInfo["responseMode"];

const CONTRACT_COLUMNS = "id::text, address, name, abi, created_at";

export class StubEngine implements EngineCommands, EngineEvents {
  readonly #pool: pg.Pool;
  readonly #clock: () => number;
  readonly #listeners = new Set<EngineListener>();
  readonly #mode: ResponseMode;
  #lastBlock = 0;

  private constructor(pool: pg.Pool, clock: () => number, mode: ResponseMode) {
    this.#pool = pool;
    this.#clock = clock;
    this.#mode = mode;
  }

  /**
   * Creates the stand-in's schemas if they are not there yet. `mode` is
   * how far it goes with a rule's on-chain action, as the engine's
   * `[response] mode`.
   */
  static async open(
    pool: pg.Pool,
    clock: () => number = Date.now,
    mode: ResponseMode = "prepare",
  ): Promise<StubEngine> {
    await pool.query(SCHEMA);
    return new StubEngine(pool, clock, mode);
  }

  /** The same events the engine streams, from the simulated chain. */
  listen(listener: EngineListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: string, data: object) {
    for (const l of this.#listeners) l.event({ event, data });
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
    const { rows } = await this.#pool.query<{
      id: string;
      enabled: boolean;
      warming: boolean;
    }>(
      `SELECT id::text, enabled, warming FROM ${STUB_VIEWS}.rules
        WHERE id = ANY($1::bigint[])`,
      [[...new Set(ids)]],
    );
    for (const r of rows) {
      this.#emit("rule_state", {
        rule_id: r.id,
        enabled: r.enabled,
        warming: r.warming,
      });
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

  /**
   * Evaluates every enabled block rule once at the current simulated
   * block, recording a violation for each that trips, as the engine does
   * on every block while a condition holds. Returns how many it recorded.
   */
  async tick(): Promise<number> {
    const clock = this.#clock();
    const block = blockAt(clock);
    const time = new Date(clock).toISOString();
    await this.#advanceResponses(block, time);
    if (block > this.#lastBlock) {
      this.#lastBlock = block;
      this.#emit("block", {
        number: block,
        hash: `0x${block.toString(16).padStart(64, "0")}`,
        time,
      });
    }
    const { rows } = await this.#pool.query<{
      id: string;
      address: string;
      document: Rule;
    }>(
      `SELECT r.id::text, c.address, r.document
         FROM stub.rules r JOIN stub.contracts c ON c.id = r.contract_id
        WHERE r.enabled AND r.document->>'when' = 'every_block'
          AND (r.last_evaluated_block IS NULL OR r.last_evaluated_block < $1)
        ORDER BY r.id LIMIT 1000`,
      [block],
    );
    let recorded = 0;
    for (const row of rows) {
      let kind: "tripped" | "evaluation_error" | null = null;
      let evidence: unknown;
      try {
        const evaluation = evaluateTrip(
          row.document.trip_when,
          row.address,
          clock,
        );
        if (evaluation.would_trip) {
          kind = "tripped";
          evidence = evaluation.evidence;
        }
      } catch (error) {
        kind = "evaluation_error";
        evidence = { error: String(error) };
      }
      // Recording the violation and moving the rule's block commit together.
      const { rows: recordedRows } = await this.#pool.query<{ id: string }>(
        `WITH moved AS (
           UPDATE stub.rules SET last_evaluated_block = $2 WHERE id = $1 RETURNING id
         )
         INSERT INTO stub.violations (rule_id, kind, block_number, block_time, evidence)
         SELECT id, $3, $2, $4, $5 FROM moved WHERE $3::text IS NOT NULL
         RETURNING id::text`,
        [row.id, block, kind, time, JSON.stringify(evidence ?? null)],
      );
      const recordedId = recordedRows[0]?.id;
      if (kind && recordedId) {
        recorded++;
        this.#emit("violation", {
          id: recordedId,
          rule_id: row.id,
          rule_name: row.document.name,
          severity: row.document.severity,
          contract_address: row.address,
          kind,
          block_number: block,
          block_time: time,
        });
        if (kind === "tripped") {
          await this.#stageResponse(recordedId, row, block, clock);
        }
      }
    }
    return recorded;
  }

  /**
   * Ticks until the returned stop is called: often enough that no
   * simulated block is missed, and each is evaluated once.
   */
  ticking(): () => Promise<void> {
    let running: Promise<unknown> = Promise.resolve();
    const timer = setInterval(() => {
      running = running.then(() => this.tick()).catch(() => {});
    }, 4_000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await running;
    };
  }

  /** One value per call; a function with several outputs gives a list. */
  /**
   * A response for a violation whose rule acts on chain: held for
   * approval, or sent at once, as the mode says. At most one is live per
   * rule, and after one another waits out the rule's quiet period.
   */
  async #stageResponse(
    violationId: string,
    rule: { id: string; address: string; document: Rule },
    block: number,
    clock: number,
  ) {
    const onTrip = rule.document.on_trip;
    if (this.#mode === "notify" || !actsOnChain(onTrip)) return;
    const quiet = onTrip.cooldown_seconds ?? DEFAULT_QUIET_SECONDS;
    const { rows: recent } = await this.#pool.query(
      `SELECT 1 FROM stub.responses p JOIN stub.violations v ON v.id = p.violation_id
        WHERE v.rule_id = $1
          AND (p.status IN ('pending', 'awaiting_approval', 'approved', 'submitted')
               OR p.created_at > $2)
        LIMIT 1`,
      [rule.id, new Date(clock - quiet * 1000).toISOString()],
    );
    if (recent.length > 0) return;
    const { rows: counted } = await this.#pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM stub.responses",
    );
    const built = buildTx(onTrip, rule.address, counted[0]?.n ?? 0);
    const sending = this.#mode === "send";
    const time = new Date(clock).toISOString();
    const { rows } = await this.#pool.query<{ id: string }>(
      `INSERT INTO stub.responses
         (violation_id, action, mode, status, tx, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id::text`,
      [
        violationId,
        onTrip.action,
        this.#mode,
        sending ? "submitted" : "awaiting_approval",
        JSON.stringify(sending ? submitted(built, block) : built),
        time,
      ],
    );
    this.#emitResponse(
      rows[0]!.id,
      rule.id,
      sending ? "submitted" : "awaiting_approval",
    );
  }

  /** Approved responses are sent; sent ones confirm a block later. */
  async #advanceResponses(block: number, time: string) {
    const { rows } = await this.#pool.query<{
      id: string;
      rule_id: string;
      status: string;
      tx: StubTx;
    }>(
      `SELECT p.id::text, v.rule_id::text, p.status, p.tx
         FROM stub.responses p JOIN stub.violations v ON v.id = p.violation_id
        WHERE p.status IN ('approved', 'submitted')`,
    );
    for (const r of rows) {
      const sentAt = r.tx.attempts.at(-1)?.block;
      const next =
        r.status === "approved"
          ? { status: "submitted", tx: submitted(r.tx, block) }
          : sentAt !== undefined && sentAt < block
            ? { status: "confirmed", tx: confirmed(r.tx, block) }
            : null;
      if (!next) continue;
      await this.#pool.query(
        "UPDATE stub.responses SET status = $2, tx = $3, updated_at = $4 WHERE id = $1",
        [r.id, next.status, JSON.stringify(next.tx), time],
      );
      this.#emitResponse(r.id, r.rule_id, next.status);
    }
  }

  #emitResponse(id: string, ruleId: string, status: string) {
    this.#emit("response", { id, rule_id: ruleId, status });
  }

  async approveResponse(id: string): Promise<void> {
    await this.#decide(id, "approved", null);
  }

  async rejectResponse(id: string, reason: string | null): Promise<void> {
    await this.#decide(
      id,
      "abandoned",
      reason ? `Rejected: ${reason}` : "Rejected.",
    );
  }

  /** A person's decision on a held response, once. */
  async #decide(id: string, status: string, error: string | null) {
    if (!/^\d+$/.test(id)) throw notFound("response");
    const { rows } = await this.#pool.query<{ rule_id: string }>(
      `UPDATE stub.responses p SET status = $2, error = $3, updated_at = $4
         FROM stub.violations v
        WHERE p.id = $1 AND v.id = p.violation_id AND p.status = 'awaiting_approval'
        RETURNING v.rule_id::text`,
      [id, status, error, new Date(this.#clock()).toISOString()],
    );
    if (rows[0]) return this.#emitResponse(id, rows[0].rule_id, status);
    const { rows: found } = await this.#pool.query<{ status: string }>(
      "SELECT status FROM stub.responses WHERE id = $1",
      [id],
    );
    if (!found[0]) throw notFound("response");
    throw new EngineError(
      409,
      "not_waiting",
      `The response is not waiting for approval: it is ${found[0].status}.`,
    );
  }

  read(calls: ReadCall[]): Promise<(string | string[])[]> {
    const clock = this.#clock();
    return Promise.resolve(
      calls.map((call) => {
        const outputs = parseSignature(call.function).returns;
        const values = outputs.map((type, i) =>
          simulatedValue(call.address, call.function, i, type, clock),
        );
        return values.length === 1 ? values[0]! : values;
      }),
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

function notFound(what: "contract" | "rule" | "response") {
  return new EngineError(404, "not_found", `No such ${what}.`);
}
