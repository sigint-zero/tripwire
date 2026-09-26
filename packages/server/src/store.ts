import type pg from "pg";

// The application's own records about engine objects, in the `app`
// schema. Each is one short statement; engine objects are named by id or
// address, and a row that outlives what it names is swept.

/** Who acted, when no account is attached to the request. */
export const DASHBOARD = "dashboard";

const PINNED = "dashboard.pinned_rules";

export interface Display {
  decimals: number | null;
  unit: string | null;
}

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

  /** A rule switched off by hand stays off when its contract is enabled. */
  async keepOff(contractId: string, ruleId: string) {
    await this.#pool.query(
      `UPDATE app.contract_disables SET rule_ids = array_remove(rule_ids, $2::bigint)
        WHERE contract_id = $1`,
      [contractId, ruleId],
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

  /** The verified source kept for a contract, with its files. */
  async source(address: string): Promise<{
    verified: boolean;
    compiler: string | null;
    files: { path: string; content: string }[];
  } | null> {
    const { rows } = await this.#pool.query<{
      verified: boolean;
      compiler: string | null;
      files: { path: string; content: string }[];
    }>(
      "SELECT verified, compiler, files FROM app.contract_sources WHERE address = $1",
      [address.toLowerCase()],
    );
    return rows[0] ?? null;
  }

  /** Records which agent stored a rule: its badge and its volume guard. */
  async recordSubmission(ruleId: string, token: { id: string; label: string }) {
    await this.#pool.query(
      `INSERT INTO app.rule_submissions (rule_id, token_id, token_label)
       VALUES ($1, $2, $3)`,
      [ruleId, token.id, token.label],
    );
  }

  /** A token's submissions in the trailing hour, oldest first. */
  async submissionsInLastHour(tokenId: string): Promise<Date[]> {
    const { rows } = await this.#pool.query<{ submitted_at: Date }>(
      `SELECT submitted_at FROM app.rule_submissions
        WHERE token_id = $1 AND submitted_at > now() - interval '1 hour'
        ORDER BY submitted_at LIMIT 10000`,
      [tokenId],
    );
    return rows.map((r) => r.submitted_at);
  }

  /** A setting's value, or `fallback` while it is unset. */
  async setting<T>(key: string, fallback: T): Promise<T> {
    const { rows } = await this.#pool.query<{ value: T }>(
      "SELECT value FROM app.settings WHERE key = $1",
      [key],
    );
    return rows[0]?.value ?? fallback;
  }

  /** How many alert channels are set up. */
  async channelCount(): Promise<number> {
    const { rows } = await this.#pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.channels",
    );
    return rows[0]?.n ?? 0;
  }

  async setSetting(key: string, value: unknown) {
    await this.#pool.query(
      `INSERT INTO app.settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)],
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

  /** How each rule's values are shown, for the rules that have a preference. */
  async displays(ruleIds: string[]): Promise<Map<string, Display>> {
    if (ruleIds.length === 0) return new Map();
    const { rows } = await this.#pool.query<{
      rule_id: string;
      display_decimals: number | null;
      display_unit: string | null;
    }>(
      "SELECT rule_id::text, display_decimals, display_unit FROM app.rule_prefs WHERE rule_id = ANY($1::bigint[])",
      [ruleIds],
    );
    return new Map(
      rows.map((r) => [
        r.rule_id,
        { decimals: r.display_decimals, unit: r.display_unit },
      ]),
    );
  }

  async setDisplay(ruleId: string, display: Display) {
    if (display.decimals === null && display.unit === null) {
      await this.#pool.query("DELETE FROM app.rule_prefs WHERE rule_id = $1", [
        ruleId,
      ]);
      return;
    }
    await this.#pool.query(
      `INSERT INTO app.rule_prefs (rule_id, display_decimals, display_unit)
       VALUES ($1, $2, $3)
       ON CONFLICT (rule_id) DO UPDATE SET
         display_decimals = excluded.display_decimals,
         display_unit = excluded.display_unit, updated_at = now()`,
      [ruleId, display.decimals, display.unit],
    );
  }

  /** The rules charted on the Overview, in order. */
  async pinned(): Promise<string[]> {
    const { rows } = await this.#pool.query<{ value: unknown }>(
      "SELECT value FROM app.settings WHERE key = $1",
      [PINNED],
    );
    const value = rows[0]?.value;
    return Array.isArray(value) ? value.map(String) : [];
  }

  async setPinned(ruleIds: string[]) {
    await this.#pool.query(
      `INSERT INTO app.settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [PINNED, JSON.stringify(ruleIds)],
    );
  }

  /** Records acknowledgements; a violation already acknowledged keeps its first. */
  async acknowledge(violationIds: string[], by: string, note: string | null) {
    if (violationIds.length === 0) return;
    await this.#pool.query(
      `INSERT INTO app.violation_acks (violation_id, acknowledged_by, note)
       SELECT id, $2, $3 FROM unnest($1::bigint[]) AS id
       ON CONFLICT (violation_id) DO NOTHING`,
      [violationIds, by, note],
    );
  }

  /**
   * Forgets what the application kept about deleted rules, in one
   * statement. Anything missed here is swept later.
   */
  async forgetRules(ruleIds: string[]) {
    if (ruleIds.length === 0) return;
    await this.#pool.query(
      `WITH prefs AS (
         DELETE FROM app.rule_prefs WHERE rule_id = ANY($1::bigint[])
       ), disables AS (
         UPDATE app.contract_disables
            SET rule_ids = ARRAY(SELECT unnest(rule_ids) EXCEPT SELECT unnest($1::bigint[]))
          WHERE rule_ids && $1::bigint[]
       )
       UPDATE app.settings
          SET value = COALESCE(
                (SELECT jsonb_agg(id) FROM jsonb_array_elements(value) AS id
                  WHERE NOT (id #>> '{}') = ANY(($1::bigint[])::text[])),
                '[]'::jsonb),
              updated_at = now()
        WHERE key = $2`,
      [ruleIds, PINNED],
    );
  }

  /** Forgets a deleted contract: its disable and its source. */
  async forgetContract(contractId: string, address: string) {
    await this.#pool.query(
      `WITH disables AS (
         DELETE FROM app.contract_disables WHERE contract_id = $1
       )
       DELETE FROM app.contract_sources WHERE address = $2`,
      [contractId, address.toLowerCase()],
    );
  }
}
