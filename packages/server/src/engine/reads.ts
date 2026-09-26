import type { ResponseStatus, ViolationKind } from "@tripwire/shared";
import type pg from "pg";
import {
  EngineNotReady,
  type ContractRow,
  type CursorRow,
  type EngineReads,
  type BucketRow,
  type PointRow,
  type ResponseRow,
  type RuleActivity,
  type RuleRow,
  type RuleSeriesRow,
  type SeriesRow,
  type TripStateRow,
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
  v.evidence, v.created_at, a.acknowledged_by, a.note, a.acknowledged_at,
  p.id::text AS response_id, p.status AS response_status`;

const SERIES = `id::text, key, address, function, args, returns,
  metric, window_seconds::int`;

const RESPONSE = `p.id::text, p.violation_id::text, p.rule_id::text,
  p.rule_name, p.contract_address, c.name AS contract_name, p.action, p.mode,
  p.status, p.tx, p.error, p.created_at, p.updated_at,
  v.kind AS violation_kind, v.block_number::int AS violation_block`;

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
      `SELECT ${VIOLATION} FROM ${this.#violations()}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY v.id DESC LIMIT ${limit}`,
      params,
    );
  }

  async violation(id: string): Promise<ViolationRow | null> {
    if (!/^\d+$/.test(id)) return null;
    const rows = await this.#read<ViolationRow>(
      `SELECT ${VIOLATION} FROM ${this.#violations()} WHERE v.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async responses(
    filter: {
      statuses?: ResponseStatus[];
      contractAddress?: string;
      before?: string;
      limit?: number;
    } = {},
  ): Promise<ResponseRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const bind = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace("?", `$${params.length}`));
    };
    if (filter.statuses) bind("p.status = ANY(?::text[])", filter.statuses);
    if (filter.contractAddress) {
      bind("p.contract_address = ?", filter.contractAddress.toLowerCase());
    }
    if (filter.before) bind("p.id < ?", filter.before);
    const limit = Math.min(Math.max(filter.limit ?? LIMIT, 1), LIMIT);
    return this.#read<ResponseRow>(
      `SELECT ${RESPONSE} FROM ${this.#responses()}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY p.id DESC LIMIT ${limit}`,
      params,
    );
  }

  async response(id: string): Promise<ResponseRow | null> {
    if (!/^\d+$/.test(id)) return null;
    const rows = await this.#read<ResponseRow>(
      `SELECT ${RESPONSE} FROM ${this.#responses()} WHERE p.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async responseCounts() {
    const [row] = await this.#read<{ waiting: number; in_flight: number }>(
      `SELECT count(*) FILTER (WHERE status = 'awaiting_approval')::int AS waiting,
              count(*) FILTER (WHERE status IN ('pending', 'approved', 'submitted'))::int AS in_flight
         FROM ${this.#schema}.responses`,
    );
    return { waiting: row?.waiting ?? 0, inFlight: row?.in_flight ?? 0 };
  }

  tripState() {
    return this.#read<TripStateRow>(
      `SELECT c.address AS contract_address, c.name AS contract_name, c.abi,
              t.selector, t.source, t.since_block::int, t.tx_hash
         FROM ${this.#schema}.trip_state t
         JOIN ${this.#schema}.contracts c
           ON lower(c.address) = lower(t.contract_address)
        WHERE t.tripped
        ORDER BY t.since_block DESC, c.address, t.selector LIMIT ${LIMIT}`,
    );
  }

  engineStatus() {
    return this.#read<CursorRow>(
      `SELECT cursor, block_number::text, updated_at, engine_version
         FROM ${this.#schema}.engine_status ORDER BY cursor`,
    );
  }

  async ruleActivity(ruleIds: string[]): Promise<RuleActivity[]> {
    if (ruleIds.length === 0) return [];
    return this.#read<RuleActivity>(
      `SELECT r.id::text AS rule_id, n.kind AS newest_kind,
              n.block_number::int AS newest_block,
              (SELECT count(*)::int FROM ${this.#schema}.violations v
                 LEFT JOIN app.violation_acks a ON a.violation_id = v.id
                WHERE v.rule_id = r.id AND a.violation_id IS NULL) AS open_count
         FROM unnest($1::bigint[]) AS r(id)
         LEFT JOIN LATERAL (
           SELECT v.kind, v.block_number FROM ${this.#schema}.violations v
            WHERE v.rule_id = r.id ORDER BY v.id DESC LIMIT 1
         ) n ON true
        LIMIT ${LIMIT}`,
      [ruleIds.slice(0, LIMIT)],
    );
  }

  async ruleSeries(ruleIds: string[]): Promise<RuleSeriesRow[]> {
    const ids = ruleIds.filter((id) => /^\d+$/.test(id));
    if (ids.length === 0) return [];
    return this.#read<RuleSeriesRow>(
      `SELECT rs.rule_id::text, rs.role, rs.path, s.id::text, s.key, s.address,
              s.function, s.args, s.returns, s.metric, s.window_seconds::int
         FROM ${this.#schema}.rule_series rs
         JOIN ${this.#schema}.series s ON s.id = rs.series_id
        WHERE rs.rule_id = ANY($1::bigint[])
        ORDER BY rs.rule_id, rs.path LIMIT ${LIMIT}`,
      [ids],
    );
  }

  async seriesById(id: string): Promise<SeriesRow | null> {
    if (!/^\d+$/.test(id)) return null;
    const rows = await this.#read<SeriesRow>(
      `SELECT ${SERIES} FROM ${this.#schema}.series WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async newestPoints(seriesIds: string[]): Promise<PointRow[]> {
    if (seriesIds.length === 0) return [];
    return this.#read<PointRow>(
      `SELECT DISTINCT ON (series_id) series_id::text, block_number::int,
              block_time, value::text
         FROM ${this.#schema}.series_points
        WHERE series_id = ANY($1::bigint[])
        ORDER BY series_id, block_number DESC
        LIMIT ${LIMIT}`,
      [seriesIds],
    );
  }

  async countPoints(seriesId: string, from: Date, to: Date) {
    const [row] = await this.#read<{ raw: number; rollups: number }>(
      `SELECT (SELECT count(*)::int FROM ${this.#schema}.series_points
                WHERE series_id = $1 AND block_time >= $2 AND block_time < $3) AS raw,
              (SELECT count(*)::int FROM ${this.#schema}.series_rollups
                WHERE series_id = $1 AND bucket_start >= $2 AND bucket_start < $3) AS rollups`,
      [seriesId, from, to],
    );
    return { raw: row?.raw ?? 0, rollups: row?.rollups ?? 0 };
  }

  async points(
    seriesId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<PointRow[]> {
    return this.#read<PointRow>(
      `SELECT series_id::text, block_number::int, block_time, value::text
         FROM ${this.#schema}.series_points
        WHERE series_id = $1 AND block_time >= $2 AND block_time < $3
        ORDER BY block_number LIMIT ${Math.min(limit, LIMIT)}`,
      [seriesId, from, to],
    );
  }

  async buckets(
    seriesIds: string[],
    from: Date,
    to: Date,
    buckets: number,
  ): Promise<BucketRow[]> {
    if (seriesIds.length === 0) return [];
    const width = Math.max((to.getTime() - from.getTime()) / 1000 / buckets, 1);
    // Raw points and hourly rollups hold each value exactly once, so both
    // feed the same buckets: min of mins, max of maxes, first and last by
    // time. A spike inside a bucket survives in its min or max.
    return this.#read<BucketRow>(
      `WITH parts AS (
         SELECT series_id, block_time AS t, value AS first, value AS last,
                value AS min, value AS max, 1 AS n
           FROM ${this.#schema}.series_points
          WHERE series_id = ANY($1::bigint[]) AND block_time >= $2 AND block_time < $3
         UNION ALL
         SELECT series_id, bucket_start, first, last, min, max, samples
           FROM ${this.#schema}.series_rollups
          WHERE series_id = ANY($1::bigint[]) AND bucket_start >= $2 AND bucket_start < $3
       )
       SELECT series_id::text,
              floor(extract(epoch FROM t - $2::timestamptz) / $4)::int AS bucket,
              (array_agg(first ORDER BY t))[1]::text AS first,
              (array_agg(last ORDER BY t DESC))[1]::text AS last,
              min(min)::text AS min, max(max)::text AS max,
              sum(n)::int AS count
         FROM parts
        GROUP BY series_id, bucket
        ORDER BY series_id, bucket
        LIMIT ${LIMIT * 10}`,
      [seriesIds, from, to, width],
    );
  }

  /** Responses with the violation that caused them and the contract's name. */
  #responses() {
    return `${this.#schema}.responses p
      LEFT JOIN ${this.#schema}.violations v ON v.id = p.violation_id
      LEFT JOIN ${this.#schema}.contracts c ON c.address = p.contract_address`;
  }

  /** Violations with their acknowledgement and their latest response. */
  #violations() {
    return `${this.#schema}.violations v
      LEFT JOIN app.violation_acks a ON a.violation_id = v.id
      LEFT JOIN LATERAL (
        SELECT r.id, r.status FROM ${this.#schema}.responses r
         WHERE r.violation_id = v.id ORDER BY r.id DESC LIMIT 1
      ) p ON true`;
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
