import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migrate, shippedMigrations, type MigrationReport } from "./migrate";
import { openExternal, openLocal, type Database } from "./provision";

/** The application data directory: `TRIPWIRE_HOME`, else `~/.tripwire`. */
export function tripwireHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRIPWIRE_HOME || join(homedir(), ".tripwire");
}

export type DatabaseTarget =
  { mode: "local" } | { mode: "external"; url: string };

/**
 * Where the database is, in order of precedence: `--database-url`, then
 * `TRIPWIRE_DATABASE_URL`, then the `database` member of `config.json`.
 * The first two force external mode for this run without rewriting the
 * file. With no file yet, first run has not chosen, and local mode holds.
 */
export async function databaseTarget(options: {
  home: string;
  url?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DatabaseTarget> {
  const env = options.env ?? process.env;
  if (options.url) return { mode: "external", url: options.url };
  if (env.TRIPWIRE_DATABASE_URL) {
    return { mode: "external", url: env.TRIPWIRE_DATABASE_URL };
  }
  const path = join(options.home, "config.json");
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return { mode: "local" };
  const config = JSON.parse(text) as {
    database?: { mode?: string; url?: string };
  };
  const database = config.database ?? { mode: "local" };
  if (database.mode === "local") return { mode: "local" };
  if (database.mode !== "external" || !database.url) {
    throw new Error(
      `${path}: database needs mode "local", or mode "external" with a url.`,
    );
  }
  const name = /^env:(.+)$/.exec(database.url)?.[1];
  if (!name) return { mode: "external", url: database.url };
  const url = env[name];
  if (!url) {
    throw new Error(
      `${path}: the database url reads ${name}, which is not set.`,
    );
  }
  return { mode: "external", url };
}

export interface StartedDatabase {
  database: Database;
  /** The application's pool: one connection in local mode, per the pooler's rules. */
  pool: pg.Pool;
  migrations: MigrationReport;
  close(): Promise<void>;
}

/**
 * The database half of starting: open it (local) or check it (external),
 * confirm it answers, and bring the `app` schema up to date. Runs before
 * the engine is spawned.
 */
export async function startDatabase(options: {
  home: string;
  url?: string;
  env?: NodeJS.ProcessEnv;
  /** Where the migration files are, when not beside the server's source. */
  migrationsDir?: string;
}): Promise<StartedDatabase> {
  const target = await databaseTarget(options);
  const database =
    target.mode === "local"
      ? await openLocal({ home: options.home })
      : await openExternal(target.url);
  const pool = new pg.Pool({
    connectionString: database.url,
    max: database.mode === "local" ? 1 : 10,
  });
  // An idle pooled connection that drops is replaced on next use.
  pool.on("error", () => {});
  try {
    await pool.query("SELECT 1");
    const migrations = await migrate(
      pool,
      await shippedMigrations(options.migrationsDir),
    );
    return {
      database,
      pool,
      migrations,
      async close() {
        await pool.end();
        await database.close();
      },
    };
  } catch (error) {
    await pool.end().catch(() => {});
    await database.close().catch(() => {});
    throw error;
  }
}
