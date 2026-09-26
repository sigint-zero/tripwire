import {
  describeRule,
  type EngineInfo,
  issuesOf,
  parseSignature,
  rule as ruleSchema,
  type Rule,
  type ViewCall,
} from "@tripwire/shared";
import type pg from "pg";
import { toFunctionSelector } from "viem";
import type { EngineEvents, EngineListener } from "../events/types";
import {
  actsOnChain,
  buildTx,
  callOf,
  confirmed,
  CONTROLLER,
  DEFAULT_QUIET_SECONDS,
  GUARDIAN,
  manualCall,
  submitted,
  txFor,
  type StubTx,
} from "./stub-responses";
import {
  blockAt,
  timeOf,
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
  type ActionRow,
  type KeyChange,
  type KeyRow,
  type ManualActionKind,
  type ManualActionRequest,
  type ResponseDryRun,
  type ReadCall,
  type RuleRow,
} from "./types";
import { KeystoreError, newKeystore, openKeystore } from "./keystore";

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
CREATE TABLE IF NOT EXISTS stub.series (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE,
  address text NOT NULL,
  function text NOT NULL,
  args jsonb NOT NULL,
  returns int,
  metric text,
  window_seconds bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stub.series_points (
  series_id bigint NOT NULL REFERENCES stub.series (id) ON DELETE CASCADE,
  block_number bigint NOT NULL,
  block_time timestamptz NOT NULL,
  value numeric NOT NULL,
  PRIMARY KEY (series_id, block_number)
);
CREATE TABLE IF NOT EXISTS stub.series_rollups (
  series_id bigint NOT NULL REFERENCES stub.series (id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  first numeric NOT NULL,
  last numeric NOT NULL,
  min numeric NOT NULL,
  max numeric NOT NULL,
  avg numeric NOT NULL,
  samples int NOT NULL,
  PRIMARY KEY (series_id, bucket_start)
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
CREATE TABLE IF NOT EXISTS stub.rule_series (
  rule_id bigint NOT NULL REFERENCES stub.rules (id) ON DELETE CASCADE,
  series_id bigint NOT NULL REFERENCES stub.series (id),
  role text NOT NULL,
  path text NOT NULL,
  PRIMARY KEY (rule_id, series_id, path)
);
CREATE TABLE IF NOT EXISTS stub.trip_state (
  contract_address text NOT NULL,
  selector text NOT NULL,
  source text NOT NULL,
  tripped boolean NOT NULL,
  since_block bigint NOT NULL,
  tx_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_address, selector, source)
);
CREATE TABLE IF NOT EXISTS stub.notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stub.controller_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  block_time timestamptz NOT NULL,
  address text NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  event_name text NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS stub.actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  target text NOT NULL,
  selector text,
  function text,
  args jsonb,
  note text,
  status text NOT NULL,
  tx jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE stub.actions ADD COLUMN IF NOT EXISTS function text;
ALTER TABLE stub.actions ADD COLUMN IF NOT EXISTS args jsonb;
CREATE TABLE IF NOT EXISTS stub.keys (
  address text PRIMARY KEY,
  keystore jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stub.cursors (
  name text PRIMARY KEY,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  updated_at timestamptz NOT NULL
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
CREATE OR REPLACE VIEW ${STUB_VIEWS}.series AS
  SELECT id, key, address, function, args, returns, metric, window_seconds, created_at
    FROM stub.series;
CREATE OR REPLACE VIEW ${STUB_VIEWS}.series_points AS
  SELECT series_id, block_number, block_time, value FROM stub.series_points;
CREATE OR REPLACE VIEW ${STUB_VIEWS}.series_rollups AS
  SELECT series_id, bucket_start, first, last, min, max, avg, samples
    FROM stub.series_rollups;
CREATE OR REPLACE VIEW ${STUB_VIEWS}.responses AS
  SELECT p.id, p.violation_id, v.rule_id, r.name AS rule_name,
         c.address AS contract_address, p.action, p.mode, p.status, p.tx,
         p.error, p.created_at, p.updated_at
    FROM stub.responses p
    JOIN stub.violations v ON v.id = p.violation_id
    JOIN stub.rules r ON r.id = v.rule_id
    JOIN stub.contracts c ON c.id = r.contract_id;
CREATE OR REPLACE VIEW ${STUB_VIEWS}.rule_series AS
  SELECT rule_id, series_id, role, path FROM stub.rule_series;
CREATE OR REPLACE VIEW ${STUB_VIEWS}.trip_state AS
  SELECT contract_address, selector, source, tripped, since_block, tx_hash, updated_at
    FROM stub.trip_state;
CREATE OR REPLACE VIEW ${STUB_VIEWS}.notifications AS
  SELECT id, kind, payload, created_at FROM stub.notifications;
DROP VIEW IF EXISTS ${STUB_VIEWS}.actions;
CREATE VIEW ${STUB_VIEWS}.actions AS
  SELECT id, kind, target, selector, function, args, note, status, tx, error,
         created_at, updated_at
    FROM stub.actions;
CREATE OR REPLACE VIEW ${STUB_VIEWS}.controller_events AS
  SELECT id, block_number, block_hash, block_time, address, tx_hash, log_index,
         event_name, payload
    FROM stub.controller_events;
CREATE OR REPLACE VIEW ${STUB_VIEWS}.engine_status AS
  SELECT name AS cursor, block_number, block_hash, updated_at,
         NULL::text AS instance_id, 'stand-in' AS engine_version,
         NULL::text AS rule_language_version
    FROM stub.cursors;
`;

type ResponseMode = EngineInfo["responseMode"];

/** A new series' simulated history: a day, a point a minute. */
const HISTORY_POINTS = 1_440;
const HISTORY_STEP_MS = 60_000;

const CONTRACT_COLUMNS = "id::text, address, name, abi, created_at";

export class StubEngine implements EngineCommands, EngineEvents {
  readonly #pool: pg.Pool;
  readonly #clock: () => number;
  readonly #listeners = new Set<EngineListener>();
  readonly #mode: ResponseMode;
  /** Keys that can sign: in memory only, so a restart locks them, as it does the engine's. */
  readonly #unlocked = new Set<string>();
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
    const stub = new StubEngine(pool, clock, mode);
    await stub.#register(null);
    return stub;
  }

  /**
   * The stand-in's controller has every contract it watches registered,
   * so the controller's pauses can be tried: `address`, or every contract
   * not registered yet. A contract registers itself on chain; this is
   * the event the engine would mirror. Its guardian then names every key
   * Tripwire holds an operator.
   */
  async #register(address: string | null) {
    const block = blockAt(this.#clock());
    const at = [
      block,
      `0x${block.toString(16).padStart(64, "0")}`,
      new Date(timeOf(block)).toISOString(),
      CONTROLLER,
    ];
    await this.#pool.query(
      `INSERT INTO stub.controller_events
         (block_number, block_hash, block_time, address, tx_hash, log_index, event_name, payload)
       SELECT $1, $2, $3, $4, '0x' || md5(c.address) || md5(c.address), 0, 'Registered',
              jsonb_build_object('guardedContract', c.address, 'guardian', $5::text)
         FROM stub.contracts c
        WHERE ($6::text IS NULL OR c.address = $6)
          AND NOT EXISTS (
            SELECT 1 FROM stub.controller_events e
             WHERE e.event_name = 'Registered'
               AND lower(e.payload->>'guardedContract') = c.address)`,
      [...at, GUARDIAN, address],
    );
    await this.#pool.query(
      `INSERT INTO stub.controller_events
         (block_number, block_hash, block_time, address, tx_hash, log_index, event_name, payload)
       SELECT $1, $2, $3, $4, '0x' || md5(r.contract || k.address) || md5(k.address), 1,
              'OperatorAdded',
              jsonb_build_object('guardedContract', r.contract,
                                 'operator', k.address, 'guardian', $5::text)
         FROM (SELECT DISTINCT lower(payload->>'guardedContract') AS contract
                 FROM stub.controller_events WHERE event_name = 'Registered') r
        CROSS JOIN stub.keys k
        WHERE NOT EXISTS (
          SELECT 1 FROM stub.controller_events e
           WHERE e.event_name IN ('OperatorAdded', 'OperatorRemoved')
             AND lower(e.payload->>'guardedContract') = r.contract
             AND lower(e.payload->>'operator') = k.address)`,
      [...at, GUARDIAN],
    );
  }

  /** The same events the engine streams, from the simulated chain. */
  listen(listener: EngineListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: string, data: object) {
    for (const l of this.#listeners) l.event({ event, data });
  }

  async health(): Promise<EngineHealth> {
    const clock = this.#clock();
    const head = blockAt(clock);
    const { rows } = await this.#pool.query<{ address: string }>(
      "SELECT address FROM stub.keys",
    );
    return {
      status: "ready",
      version: "stand-in",
      chain_id: 1,
      observed_head: head,
      evaluated_block: head,
      cursors: [
        {
          name: "ingest",
          block_number: head,
          block_hash: `0x${head.toString(16).padStart(64, "0")}`,
          age_seconds: Math.floor((clock - timeOf(head)) / 1000),
        },
      ],
      rpc: {
        state: "ok",
        observed_head: head,
        last_success_unix_ms: clock,
        last_failure_unix_ms: null,
      },
      // The controller its responses pause through, mirrored as it goes.
      controller: { address: CONTROLLER, mirrored_block: head },
      keys: {
        known: rows.length,
        unlocked: rows.filter((r) => this.#unlocked.has(r.address)).length,
      },
    };
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
      await this.#register(address);
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
    await this.#advanceActions(block, time);
    if (block > this.#lastBlock) {
      this.#lastBlock = block;
      const hash = `0x${block.toString(16).padStart(64, "0")}`;
      await this.#pool.query(
        `INSERT INTO stub.cursors (name, block_number, block_hash, updated_at)
         VALUES ('ingest', $1, $2, $3)
         ON CONFLICT (name) DO UPDATE
           SET block_number = $1, block_hash = $2, updated_at = $3`,
        [block, hash, time],
      );
      this.#emit("block", { number: block, hash, time });
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
      await this.#record(row, block, clock);
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
          // A violation files the tree under `trip_when`, as the engine does.
          evidence = { trip_when: evaluation.evidence };
        }
      } catch (error) {
        kind = "evaluation_error";
        evidence = { path: "/trip_when", error: String(error) };
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
          await this.#notifyTrip(recordedId, row, block, time, clock);
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
   * Records the value of each number the rule reads at this block, into
   * series shared by every rule reading the same thing. A series seen for
   * the first time gets a day of simulated history, so a chart has
   * something to show from the start.
   */
  async #record(
    rule: { id: string; address: string; document: Rule },
    block: number,
    clock: number,
  ) {
    for (const { read, path } of recordedReads(rule.document)) {
      const address = (read.address ?? rule.address).toLowerCase();
      const returns = read.returns ?? 0;
      const type = parseSignature(read.function).returns[returns] ?? "";
      if (!/^u?int\d*$/.test(type)) continue;
      const key = JSON.stringify([address, read.function, read.args, returns]);
      const created = await this.#pool.query<{ id: string }>(
        `INSERT INTO stub.series (key, address, function, args, returns)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key) DO NOTHING RETURNING id::text`,
        [key, address, read.function, JSON.stringify(read.args), returns],
      );
      const id =
        created.rows[0]?.id ??
        (
          await this.#pool.query<{ id: string }>(
            "SELECT id::text FROM stub.series WHERE key = $1",
            [key],
          )
        ).rows[0]!.id;
      await this.#pool.query(
        `INSERT INTO stub.rule_series (rule_id, series_id, role, path)
         VALUES ($1, $2, 'read', $3) ON CONFLICT DO NOTHING`,
        [rule.id, id, path],
      );
      const value = (t: number) =>
        simulatedValue(address, read.function, returns, type, t);
      const times = created.rows[0]
        ? Array.from(
            { length: HISTORY_POINTS },
            (_, i) => clock - (HISTORY_POINTS - i) * HISTORY_STEP_MS,
          )
        : [];
      times.push(clock);
      await this.#pool.query(
        `INSERT INTO stub.series_points (series_id, block_number, block_time, value)
         SELECT $1, b, t, v
           FROM unnest($2::bigint[], $3::timestamptz[], $4::numeric[]) AS p(b, t, v)
         ON CONFLICT DO NOTHING`,
        [
          id,
          times.map((t) => (t === clock ? block : blockAt(t))),
          times.map((t) => new Date(t).toISOString()),
          times.map(value),
        ],
      );
    }
  }

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
    await this.#emitResponse(
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
      address: string;
      document: Rule;
    }>(
      `SELECT p.id::text, v.rule_id::text, p.status, p.tx, c.address, r.document
         FROM stub.responses p
         JOIN stub.violations v ON v.id = p.violation_id
         JOIN stub.rules r ON r.id = v.rule_id
         JOIN stub.contracts c ON c.id = r.contract_id
        WHERE p.status IN ('approved', 'submitted')`,
    );
    for (const r of rows) {
      const sentAt = r.tx.attempts.at(-1)?.submitted_block;
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
      await this.#emitResponse(r.id, r.rule_id, next.status);
      if (next.status === "confirmed") {
        await this.#paused(
          r.document.on_trip,
          r.address,
          r.tx.hash,
          block,
          time,
        );
      }
    }
  }

  /**
   * What a confirmed response left paused, as the engine records it: the
   * controller's pause under `controller`, a call whose confirmation now
   * holds under `verify`. A call without one changes nothing observed.
   */
  async #paused(
    onTrip: Rule["on_trip"],
    address: string,
    hash: string,
    block: number,
    time: string,
  ) {
    const row =
      onTrip.action === "trip_global"
        ? { selector: "", source: "controller", tx: hash }
        : onTrip.action === "trip_function"
          ? {
              selector: toFunctionSelector(onTrip.function),
              source: "controller",
              tx: hash,
            }
          : onTrip.action === "call" && onTrip.call.verify
            ? {
                selector: toFunctionSelector(onTrip.call.function),
                source: "verify",
                tx: null,
              }
            : null;
    if (!row) return;
    const at = (
      (onTrip.action === "call" && onTrip.call.address) ||
      address
    ).toLowerCase();
    await this.#pool.query(
      `INSERT INTO stub.trip_state
         (contract_address, selector, source, tripped, since_block, tx_hash, updated_at)
       VALUES ($1, $2, $3, true, $4, $5, $6)
       ON CONFLICT (contract_address, selector, source) DO UPDATE
         SET tripped = true, since_block = excluded.since_block,
             tx_hash = excluded.tx_hash, updated_at = excluded.updated_at
         WHERE NOT stub.trip_state.tripped`,
      [at, row.selector, row.source, block, row.tx, time],
    );
    this.#emit("trip_state", {
      contract_address: at,
      selector: row.selector,
      source: row.source,
      tripped: true,
      since_block: block,
      tx_hash: row.tx,
      updated_at: time,
    });
  }

  /**
   * A response's change, as the engine streams it: the whole view row.
   * Its notification takes the engine's two forms: a settled transaction
   * names only the response and its receipt; anything else carries the
   * rule, and the detail of what happened.
   */
  async #emitResponse(id: string, ruleId: string, status: string) {
    const { rows } = await this.#pool.query<{
      rule_name: string;
      contract_address: string;
      action: string;
      error: string | null;
      tx: StubTx | null;
      updated_at: Date;
      severity: string;
    }>(
      `SELECT p.*, r.severity FROM ${STUB_VIEWS}.responses p
         JOIN stub.rules r ON r.id = p.rule_id WHERE p.id = $1`,
      [id],
    );
    const response = rows[0];
    if (!response) return;
    const { severity, ...row } = response;
    this.#emit("response", row);
    const time = response.updated_at.toISOString();
    if (status === "confirmed") {
      await this.#notify(
        "response",
        {
          id: Number(id),
          status,
          tx_hash: response.tx?.hash ?? null,
          block_number: response.tx?.confirmed_block ?? null,
          error: null,
        },
        time,
      );
    } else if (status === "awaiting_approval" || status === "abandoned") {
      // Waiting is announced as the engine announces its hold: a person must act.
      await this.#notify(
        "response",
        {
          response_id: Number(id),
          rule_id: Number(ruleId),
          rule: response.rule_name,
          severity,
          contract: response.contract_address,
          action: response.action,
          status,
          detail: response.error,
        },
        time,
      );
    }
  }

  /**
   * A trip's notification, as the engine records it: one per trip,
   * except inside the rule's quiet period, where the violation is
   * recorded and nobody is told again.
   */
  async #notifyTrip(
    violationId: string,
    rule: { id: string; address: string; document: Rule },
    block: number,
    time: string,
    clock: number,
  ) {
    const quiet = rule.document.on_trip.cooldown_seconds ?? 0;
    if (quiet > 0) {
      const { rows } = await this.#pool.query(
        `SELECT 1 FROM stub.notifications
          WHERE kind = 'violation' AND payload->>'rule_id' = $1 AND created_at > $2
          LIMIT 1`,
        [rule.id, new Date(clock - quiet * 1000).toISOString()],
      );
      if (rows.length > 0) return;
    }
    const { rows: described } = await this.#pool.query<{ description: string }>(
      "SELECT description FROM stub.rules WHERE id = $1",
      [rule.id],
    );
    await this.#notify(
      "violation",
      {
        violation_id: Number(violationId),
        rule_id: Number(rule.id),
        rule: rule.document.name,
        contract: rule.address,
        severity: rule.document.severity,
        kind: "tripped",
        block_number: block,
        block_time: time,
        tx_hash: null,
        description: described[0]?.description ?? "",
      },
      time,
    );
  }

  /** Records a notification in the engine's envelope, and streams its row. */
  async #notify(kind: string, payload: object, time: string) {
    const complete = { ...payload, chain_id: 1, engine_version: "stand-in" };
    const { rows } = await this.#pool.query<{ id: string }>(
      `INSERT INTO stub.notifications (kind, payload, created_at)
       VALUES ($1, $2, $3) RETURNING id::text`,
      [kind, JSON.stringify(complete), time],
    );
    this.#emit("notification", {
      id: rows[0]!.id,
      kind,
      payload: complete,
      created_at: time,
    });
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

  // Keys: kept in the stand-in's database rather than files, as keystores
  // any Ethereum tool opens. Each holds a simulated ether, enough for gas.

  async keys(): Promise<KeyRow[]> {
    const { rows } = await this.#pool.query<{ address: string }>(
      "SELECT address FROM stub.keys ORDER BY created_at, address",
    );
    return rows.map((r) => ({
      address: r.address,
      unlocked: this.#unlocked.has(r.address),
      balance: "1000000000000000000",
    }));
  }

  async createKey(passphrase: string): Promise<KeyChange> {
    const { address, keystore } = await newKeystore(passphrase);
    await this.#pool.query(
      "INSERT INTO stub.keys (address, keystore) VALUES ($1, $2)",
      [address, JSON.stringify(keystore)],
    );
    this.#unlocked.add(address);
    await this.#register(null);
    return { address, unlocked: true };
  }

  async importKey(keystore: object, passphrase: string): Promise<KeyChange> {
    const address = await opened(keystore, passphrase);
    // Stored carrying its address, so listing never needs the passphrase.
    await this.#pool.query(
      `INSERT INTO stub.keys (address, keystore) VALUES ($1, $2)
       ON CONFLICT (address) DO UPDATE SET keystore = excluded.keystore`,
      [address, JSON.stringify({ ...keystore, address: address.slice(2) })],
    );
    await this.#register(null);
    return { address, unlocked: this.#unlocked.has(address) };
  }

  async unlockKey(address: string, passphrase: string): Promise<KeyChange> {
    const key = address.toLowerCase();
    const { rows } = await this.#pool.query<{ keystore: object }>(
      "SELECT keystore FROM stub.keys WHERE address = $1",
      [key],
    );
    if (!rows[0]) throw noKey(key);
    await opened(rows[0].keystore, passphrase);
    this.#unlocked.add(key);
    return { address: key, unlocked: true };
  }

  async lockKey(address: string): Promise<KeyChange> {
    const key = address.toLowerCase();
    const { rows } = await this.#pool.query(
      "SELECT 1 FROM stub.keys WHERE address = $1",
      [key],
    );
    if (!rows[0]) throw noKey(key);
    this.#unlocked.delete(key);
    return { address: key, unlocked: false };
  }

  /** The key that signs: the only one, as the engine chooses with no `[response] key`. */
  async #signingKey(): Promise<string> {
    const { rows } = await this.#pool.query<{ address: string }>(
      "SELECT address FROM stub.keys ORDER BY address",
    );
    if (rows.length === 1) return rows[0]!.address;
    throw new EngineError(
      400,
      "no_key",
      rows.length === 0
        ? "no operator key exists yet; create one under /v1/keys first"
        : `${rows.length} keys exist and [response] key does not say which signs`,
    );
  }

  /** Whether the controller names `key` an operator on `contract` now. */
  async #isOperator(contract: string, key: string): Promise<boolean> {
    const { rows } = await this.#pool.query<{ event_name: string }>(
      `SELECT event_name FROM stub.controller_events
        WHERE event_name IN ('OperatorAdded', 'OperatorRemoved')
          AND lower(payload->>'guardedContract') = $1
          AND lower(payload->>'operator') = $2
        ORDER BY block_number DESC, log_index DESC, id DESC LIMIT 1`,
      [contract.toLowerCase(), key],
    );
    return rows[0]?.event_name === "OperatorAdded";
  }

  async responseDryRun(ruleId: string): Promise<ResponseDryRun> {
    if (!/^\d+$/.test(ruleId)) throw notFound("rule");
    const { rows } = await this.#pool.query<{
      document: Rule;
      address: string;
    }>(
      `SELECT r.document, c.address FROM stub.rules r
         JOIN stub.contracts c ON c.id = r.contract_id WHERE r.id = $1`,
      [ruleId],
    );
    const rule = rows[0];
    if (!rule) throw notFound("rule");
    const onTrip = rule.document.on_trip;
    if (!actsOnChain(onTrip)) {
      throw new EngineError(
        400,
        "invalid_request",
        "the rule's action is notify; there is nothing to send",
      );
    }
    const sender = await this.#signingKey();
    const call = callOf(onTrip, rule.address);
    const preview = { ...call, value: call.value ?? "0", sender };
    if (
      onTrip.action !== "call" &&
      !(await this.#isOperator(rule.address, sender))
    ) {
      return {
        ok: false,
        revert_reason: "caller is not the guardian or an operator",
        gas_estimate: null,
        preview,
      };
    }
    return { ok: true, revert_reason: null, gas_estimate: 48_213, preview };
  }

  async createAction(input: ManualActionRequest): Promise<ActionRow> {
    const target = input.target.toLowerCase();
    const call = input.action === "call";
    const functionLevel =
      input.action === "trip_function" || input.action === "reset_function";
    const refusal = call
      ? input.selector
        ? "call takes no selector; declare the function instead"
        : !input.function
          ? 'call needs a function, e.g. "pause()"'
          : null
      : input.function || input.args?.length
        ? `${input.action} takes no function or arguments; those belong to the call kind`
        : functionLevel !== Boolean(input.selector)
          ? functionLevel
            ? `${input.action} needs the function's selector`
            : `${input.action} takes no selector`
          : null;
    if (refusal) throw new EngineError(400, "invalid_request", refusal);
    const sender = await this.#signingKey();
    const insert = `INSERT INTO stub.actions
         (kind, target, selector, function, args, note, status, tx, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id::text, kind, target, selector, function, args, note, status,
                 tx, error, created_at, updated_at`;
    const recorded = [
      input.action,
      target,
      input.selector ?? null,
      call ? input.function : null,
      call ? JSON.stringify(input.args ?? []) : null,
      input.note ?? null,
    ];
    if (!this.#unlocked.has(sender)) {
      // As the engine does: recorded and failed at once, not refused.
      const error = `the signing key ${sender} is locked`;
      const { rows } = await this.#pool.query<ActionRow>(insert, [
        ...recorded,
        "failed",
        null,
        error,
      ]);
      const failed = rows[0]!;
      await this.#notify(
        "action",
        {
          action_id: Number(failed.id),
          kind: failed.kind,
          target,
          selector: failed.selector,
          function: failed.function,
          note: failed.note,
          status: "failed",
          detail: error,
        },
        new Date(this.#clock()).toISOString(),
      );
      return failed;
    }
    const block = blockAt(this.#clock());
    const { rows: counted } = await this.#pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM stub.actions",
    );
    const nonce = counted[0]?.n ?? 0;
    const tx = submitted(
      txFor(
        input.action === "call"
          ? {
              target,
              function: input.function!,
              decoded_args: input.args ?? [],
            }
          : manualCall(input.action, target, input.selector ?? null),
        nonce,
        `action:${target}:${nonce}`,
      ),
      block,
    );
    const { rows } = await this.#pool.query<ActionRow>(insert, [
      ...recorded,
      "submitted",
      JSON.stringify(tx),
      null,
    ]);
    return rows[0]!;
  }

  /** A person's pause, unpause or call confirms a block after it was sent. */
  async #advanceActions(block: number, time: string) {
    const { rows } = await this.#pool.query<{
      id: string;
      kind: ManualActionKind;
      target: string;
      selector: string | null;
      function: string | null;
      tx: StubTx;
    }>(
      `SELECT id::text, kind, target, selector, function, tx FROM stub.actions
        WHERE status = 'submitted'`,
    );
    for (const a of rows) {
      const sentAt = a.tx.attempts.at(-1)?.submitted_block;
      if (sentAt === undefined || sentAt >= block) continue;
      await this.#pool.query(
        "UPDATE stub.actions SET status = 'confirmed', tx = $2, updated_at = $3 WHERE id = $1",
        [a.id, JSON.stringify(confirmed(a.tx, block)), time],
      );
      if (a.kind === "call") {
        await this.#called(a.target, a.function ?? "", block, time);
      } else {
        await this.#controllerActed({ ...a, kind: a.kind }, block, time);
      }
      await this.#notify(
        "action",
        {
          id: Number(a.id),
          status: "confirmed",
          tx_hash: a.tx.hash,
          block_number: block,
          error: null,
        },
        time,
      );
    }
  }

  /**
   * What a call to the contract's own function changes, as the engine
   * observes it: a rule's confirmation of that function now holds, and an
   * unpause lifts every one on the contract. The engine records no
   * transaction for an observed pause.
   */
  async #called(target: string, fn: string, block: number, time: string) {
    const { rows: rules } = await this.#pool.query<{ document: Rule }>(
      `SELECT r.document FROM stub.rules r
         JOIN stub.contracts c ON c.id = r.contract_id
        WHERE r.enabled AND lower(c.address) = $1`,
      [target],
    );
    const selector = toFunctionSelector(fn);
    const confirms = rules.some(
      ({ document: { on_trip: onTrip } }) =>
        onTrip.action === "call" &&
        onTrip.call.verify !== undefined &&
        toFunctionSelector(onTrip.call.function) === selector,
    );
    const lifts = /^unpause\b/i.test(fn);
    if (!confirms && !lifts) return;
    const { rows: changed } = await this.#pool.query<{ selector: string }>(
      lifts
        ? `UPDATE stub.trip_state SET tripped = false, since_block = $2, updated_at = $3
            WHERE contract_address = $1 AND source = 'verify' AND tripped
            RETURNING selector`
        : `INSERT INTO stub.trip_state
             (contract_address, selector, source, tripped, since_block, tx_hash, updated_at)
           VALUES ($1, $4, 'verify', true, $2, NULL, $3)
           ON CONFLICT (contract_address, selector, source) DO UPDATE
             SET tripped = true, since_block = excluded.since_block,
                 updated_at = excluded.updated_at
             WHERE NOT stub.trip_state.tripped
           RETURNING selector`,
      lifts ? [target, block, time] : [target, block, time, selector],
    );
    for (const row of changed) {
      this.#emit("trip_state", {
        contract_address: target,
        selector: row.selector,
        source: "verify",
        tripped: !lifts,
        since_block: block,
        tx_hash: null,
        updated_at: time,
      });
    }
  }

  /** The controller's pause or unpause, as the engine mirrors it. */
  async #controllerActed(
    a: {
      kind: Exclude<ManualActionKind, "call">;
      target: string;
      selector: string | null;
      tx: StubTx;
    },
    block: number,
    time: string,
  ) {
    const tripped = a.kind.startsWith("trip");
    const selector = a.selector ?? "";
    // The controller's own record of it, as the engine mirrors it.
    const sender = await this.#signingKey().catch(() => null);
    await this.#pool.query(
      `INSERT INTO stub.controller_events
         (block_number, block_hash, block_time, address, tx_hash, log_index, event_name, payload)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`,
      [
        block,
        `0x${block.toString(16).padStart(64, "0")}`,
        time,
        CONTROLLER,
        a.tx.hash,
        {
          trip_global: "GlobalTripped",
          trip_function: "FunctionTripped",
          reset_global: "GlobalReset",
          reset_function: "FunctionReset",
        }[a.kind],
        JSON.stringify({
          guardedContract: a.target,
          ...(a.selector ? { selector: a.selector } : {}),
          [tripped ? "triggeredBy" : "operator"]: sender,
        }),
      ],
    );
    await this.#pool.query(
      `INSERT INTO stub.trip_state
         (contract_address, selector, source, tripped, since_block, tx_hash, updated_at)
       VALUES ($1, $2, 'controller', $3, $4, $5, $6)
       ON CONFLICT (contract_address, selector, source) DO UPDATE
         SET tripped = excluded.tripped, since_block = excluded.since_block,
             tx_hash = excluded.tx_hash, updated_at = excluded.updated_at`,
      [a.target, selector, tripped, block, a.tx.hash, time],
    );
    this.#emit("trip_state", {
      contract_address: a.target,
      selector,
      source: "controller",
      tripped,
      since_block: block,
      tx_hash: a.tx.hash,
      updated_at: time,
    });
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

/**
 * The reads a rule records, each where the document first makes it: every
 * `view_call` in `trip_when` outside a metric, which samples its own base.
 */
function recordedReads(rule: Rule): { read: ViewCall; path: string }[] {
  const found = new Map<string, { read: ViewCall; path: string }>();
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const n = node as { node?: string };
    if (n.node === "metric") return;
    if (n.node === "view_call") {
      const read = node as ViewCall;
      const key = JSON.stringify([
        (read.address ?? rule.contract).toLowerCase(),
        read.function,
        read.args,
        read.returns ?? 0,
      ]);
      if (!found.has(key)) found.set(key, { read, path });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      walk(child, `${path}/${key}`);
    }
  };
  walk(rule.trip_when, "/trip_when");
  return [...found.values()];
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

/** A keystore's address once it opens, refused in the engine's words when not. */
async function opened(keystore: unknown, passphrase: string) {
  try {
    return await openKeystore(keystore, passphrase);
  } catch (error) {
    if (!(error instanceof KeystoreError)) throw error;
    throw new EngineError(400, error.code, error.message);
  }
}

function noKey(address: string) {
  return new EngineError(404, "not_found", `No key with address ${address}.`);
}

function notFound(what: "contract" | "rule" | "response") {
  return new EngineError(404, "not_found", `No such ${what}.`);
}
