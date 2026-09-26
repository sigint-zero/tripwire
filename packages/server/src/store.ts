import type pg from "pg";

// The application's own records about engine objects, in the `app`
// schema. Each is one short statement; engine objects are named by id or
// address, and a row that outlives what it names is swept.

export interface ContractSource {
  address: string;
  verified: boolean;
  compiler: string | null;
  implementation: string | null;
  files: { path: string; content: string }[];
  fetchedFrom: string;
}

export class AppStore {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  /** Disabled contracts, each with the rules disabling it switched off. */
  async disables(): Promise<Map<string, string[]>> {
    const { rows } = await this.#pool.query<{
      contract_id: string;
      rule_ids: string[];
    }>(
      "SELECT contract_id::text, rule_ids::text[] FROM app.contract_disables LIMIT 10000",
    );
    return new Map(rows.map((r) => [r.contract_id, r.rule_ids]));
  }

  async disable(contractId: string): Promise<string[] | null> {
    const { rows } = await this.#pool.query<{ rule_ids: string[] }>(
      "SELECT rule_ids::text[] FROM app.contract_disables WHERE contract_id = $1",
      [contractId],
    );
    return rows[0]?.rule_ids ?? null;
  }

  async recordDisable(contractId: string, ruleIds: string[], by: string) {
    await this.#pool.query(
      `INSERT INTO app.contract_disables (contract_id, rule_ids, disabled_by)
       VALUES ($1, $2::bigint[], $3)`,
      [contractId, ruleIds, by],
    );
  }

  async clearDisable(contractId: string) {
    await this.#pool.query(
      "DELETE FROM app.contract_disables WHERE contract_id = $1",
      [contractId],
    );
  }

  /** Where each contract's ABI came from: addresses with a verified source. */
  async sources(): Promise<
    Map<string, { verified: boolean; implementation: string | null }>
  > {
    const { rows } = await this.#pool.query<{
      address: string;
      verified: boolean;
      implementation: string | null;
    }>(
      "SELECT address, verified, implementation FROM app.contract_sources LIMIT 10000",
    );
    return new Map(rows.map((r) => [r.address, r]));
  }

  async saveSource(source: ContractSource) {
    await this.#pool.query(
      `INSERT INTO app.contract_sources
         (address, verified, compiler, implementation, files, fetched_from)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (address) DO UPDATE SET
         verified = excluded.verified, compiler = excluded.compiler,
         implementation = excluded.implementation, files = excluded.files,
         fetched_from = excluded.fetched_from, fetched_at = now()`,
      [
        source.address.toLowerCase(),
        source.verified,
        source.compiler,
        source.implementation?.toLowerCase() ?? null,
        JSON.stringify(source.files),
        source.fetchedFrom,
      ],
    );
  }

  /** The token that submitted each rule, for rules an agent stored. */
  async submitters(ruleIds: string[]): Promise<Map<string, string>> {
    if (ruleIds.length === 0) return new Map();
    const { rows } = await this.#pool.query<{
      rule_id: string;
      token_label: string;
    }>(
      "SELECT rule_id::text, token_label FROM app.rule_submissions WHERE rule_id = ANY($1::bigint[])",
      [ruleIds],
    );
    return new Map(rows.map((r) => [r.rule_id, r.token_label]));
  }
}
