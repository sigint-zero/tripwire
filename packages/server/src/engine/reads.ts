import type { ViolationKind } from "@tripwire/shared";
import type pg from "pg";
import {
  EngineNotReady,
  type ContractRow,
  type EngineReads,
  type RuleRow,
  type ViolationRow,
} from "./types";

// Reads the engine's state from its views, by name. The rules for the
// shared database apply: every identifier is schema-qualified, each read
// is one short transaction with a statement timeout, every list is
// bounded, and nothing session-scoped is left behind.

const LIMIT = 1000;
const TIMEOUT = "5s";

const CONTRACT = `id::text, address, name, abi, created_at,
  rule_count::int, enabled_count::int`;
const RULE = `id::text, contract_id::text, contract_address, name, document,
  description, severity, enabled, origin, warming, last_evaluated_block::int,
  created_at, updated_at`;
const VIOLATION = `v.id::text, v.rule_id::text, v.rule_name, v.severity,
  v.contract_address, v.kind, v.block_number::int, v.block_time, v.tx_hash,
  v.evidence, v.created_at, a.acknowledged_by, a.note, a.acknowledged_at`;

export class ViewReads implements EngineReads {
  readonly #pool: pg.Pool;
  readonly #schema: string;

  /** `schema` is `api_v1` for the engine, or the stand-in's copy of it. */
  constructor(pool: pg.Pool, schema = "api_v1") {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error(`Not a schema name: ${schema}`);
    }
    this.#pool = pool;
    this.#schema = schema;
  }

  async contracts(): Promise<ContractRow[]> {
    return this.#read<ContractRow>(
      `SELECT ${CONTRACT} FROM ${this.#schema}.contracts ORDER BY name, id LIMIT ${LIMIT}`,
    );
  }

  async contract(address: string): Promise<ContractRow | null> {
    const rows = await this.#read<ContractRow>(
      `SELECT ${CONTRACT} FROM ${this.#schema}.contracts WHERE address = $1`,
      [address.toLowerCase()],
    );
    return rows[0] ?? null;
  }

  async rules(filter: { contractId?: string } = {}): Promise<RuleRow[]> {
    return filter.contractId
      ? this.#read<RuleRow>(
          `SELECT ${RULE} FROM ${this.#schema}.rules WHERE contract_id = $1
            ORDER BY created_at DESC, id DESC LIMIT ${LIMIT}`,
          [filter.contractId],
        )
      : this.#read<RuleRow>(
          `SELECT ${RULE} FROM ${this.#schema}.rules
            ORDER BY created_at DESC, id DESC LIMIT ${LIMIT}`,
        );
  }

  async rule(id: string): Promise<RuleRow | null> {
    if (!/^\d+$/.test(id)) return null;
    const rows = await this.#read<RuleRow>(
      `SELECT ${RULE} FROM ${this.#schema}.rules WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  // Acknowledgements are the application's, joined in so that "open" and
  // the page bound are decided by the same query.
  async violations(
    filter: {
      ids?: string[];
      ruleId?: string;
      kind?: ViolationKind;
      contractId?: string;
      open?: boolean;
      before?: string;
      limit?: number;
    } = {},
  ): Promise<ViolationRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const bind = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace("?", `$${params.length}`));
    };
    if (filter.ids) bind("v.id = ANY(?::bigint[])", filter.ids);
    if (filter.ruleId) bind("v.rule_id = ?", filter.ruleId);
    if (filter.kind) bind("v.kind = ?", filter.kind);
    if (filter.contractId) {
      bind(
        `v.rule_id IN (SELECT r.id FROM ${this.#schema}.rules r WHERE r.contract_id = ?)`,
        filter.contractId,
      );
    }
    if (filter.before) bind("v.id < ?", filter.before);
    if (filter.open) where.push("a.violation_id IS NULL");
    const limit = Math.min(Math.max(filter.limit ?? LIMIT, 1), LIMIT);
    return this.#read<ViolationRow>(
      `SELECT ${VIOLATION} FROM ${this.#schema}.violations v
         LEFT JOIN app.violation_acks a ON a.violation_id = v.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY v.id DESC LIMIT ${limit}`,
      params,
    );
  }

  async violation(id: string): Promise<ViolationRow | null> {
    if (!/^\d+$/.test(id)) return null;
    const rows = await this.#read<ViolationRow>(
      `SELECT ${VIOLATION} FROM ${this.#schema}.violations v
         LEFT JOIN app.violation_acks a ON a.violation_id = v.id
        WHERE v.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async #read<T extends object>(sql: string, params: unknown[] = []) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = '${TIMEOUT}'`);
      const { rows } = await client.query<T>(sql, params);
      await client.query("COMMIT");
      return rows.map(timestampsAsText);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      // Until the engine has migrated, its views do not exist.
      const code = (error as { code?: string }).code;
      if (code === "3F000" || code === "42P01") throw new EngineNotReady();
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Timestamps travel as ISO text, as the API sends them. */
function timestampsAsText<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const [key, value] of Object.entries(out)) {
    if (value instanceof Date) out[key] = value.toISOString();
  }
  return out as T;
}
