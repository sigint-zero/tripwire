import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { DatabaseSetupError } from "./errors";

/** One shipped file: `NNNN_name.sql`. */
export interface Migration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

export interface MigrationReport {
  /** Versions this run applied, in order. */
  applied: number[];
  /** The highest version now recorded. */
  version: number;
}

const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));
const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** Serialises runners across processes; any fixed key would do. */
const LOCK_KEY = "7406117223340170245";

/** The migrations shipped with the server, checked to be contiguous from 0001. */
export async function shippedMigrations(
  directory = MIGRATIONS,
): Promise<Migration[]> {
  const files = (await readdir(directory))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const migrations: Migration[] = [];
  for (const [index, file] of files.entries()) {
    const match = FILE.exec(file);
    if (!match) throw new Error(`Migration file name not understood: ${file}`);
    const version = Number(match[1]);
    if (version !== index + 1) {
      throw new Error(
        `Migrations must be numbered contiguously from 0001; ${file} breaks the sequence.`,
      );
    }
    const sql = await readFile(`${directory}/${file}`, "utf8");
    migrations.push({ version, name: file, checksum: sha256(sql), sql });
  }
  return migrations;
}

/**
 * Brings the `app` schema up to the shipped migrations. Each file runs in
 * its own transaction, which first takes a transaction-scoped advisory
 * lock and re-reads the ledger, so two processes starting together apply
 * each file once. A transaction-scoped lock ends with its transaction,
 * which keeps the runner correct behind the local pooler.
 */
export async function migrate(
  pool: pg.Pool,
  migrations?: Migration[],
): Promise<MigrationReport> {
  const shipped = migrations ?? (await shippedMigrations());
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    checkLedger(await readLedger(client), shipped);
    for (const migration of shipped) {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
        const ledger = await readLedger(client);
        checkLedger(ledger, shipped);
        if (!ledger.has(migration.version)) {
          await client.query(migration.sql);
          await client.query(
            "INSERT INTO app.migrations (version, name, checksum) VALUES ($1, $2, $3)",
            [migration.version, migration.name, migration.checksum],
          );
          applied.push(migration.version);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (error instanceof DatabaseSetupError) throw error;
        throw new DatabaseSetupError(
          "migration_failed",
          `Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    client.release();
  }
  return { applied, version: shipped.at(-1)?.version ?? 0 };
}

/** The versions and checksums recorded so far; empty before 0001 has run. */
export async function readLedger(
  client: pg.PoolClient | pg.Client,
): Promise<Map<number, string>> {
  const { rows: present } = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('app.migrations') IS NOT NULL AS exists",
  );
  if (!present[0]?.exists) return new Map();
  const { rows } = await client.query<{ version: number; checksum: string }>(
    "SELECT version, checksum FROM app.migrations ORDER BY version",
  );
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

function checkLedger(ledger: Map<number, string>, shipped: Migration[]) {
  const newest = shipped.at(-1)?.version ?? 0;
  for (const [version, checksum] of ledger) {
    if (version > newest) {
      throw new DatabaseSetupError(
        "app_schema_newer",
        `The database's app schema is at version ${Math.max(...ledger.keys())}, newer than this application's ${newest}. Upgrade the application.`,
      );
    }
    const file = shipped[version - 1];
    if (file && file.checksum !== checksum) {
      throw new DatabaseSetupError(
        "migration_altered",
        `Migration ${file.name} was changed after it was applied. Applied migrations are never edited; ship a new file instead.`,
      );
    }
  }
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
