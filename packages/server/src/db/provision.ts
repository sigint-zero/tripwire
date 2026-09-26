import { PGlite } from "@electric-sql/pglite";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { DatabaseSetupError } from "./errors";
import { Pooler } from "./pooler";

/**
 * Provides the one database the application and the engine share. Local
 * mode brings up PGlite under the data directory and serves it through
 * the pooler; external mode checks the owner's server. Either way the
 * rest of the application sees a URL.
 */
export interface Database {
  mode: "local" | "external";
  url: string;
  close(): Promise<void>;
}

export interface LocalOptions {
  /** `TRIPWIRE_HOME`. */
  home: string;
  idleInTransactionMs?: number;
}

/** Opens the local database, taking its lock; `close` releases everything. */
export async function openLocal(options: LocalOptions): Promise<Database> {
  const root = join(options.home, "db");
  await privateDirectory(root);
  const releaseLock = await takeLock(join(root, "lock"));
  let db: PGlite | null = null;
  let pooler: Pooler | null = null;
  const endpointFile = join(root, "endpoint.json");
  try {
    const dataDir = join(root, "data");
    await privateDirectory(dataDir);
    db = await PGlite.create({ dataDir });
    pooler = new Pooler(db, {
      idleInTransactionMs: options.idleInTransactionMs,
    });

    let url: string;
    if (process.platform === "win32") {
      // No Unix sockets: loopback on a free port, recorded for the CLI.
      const bound = await pooler.listen({ host: "127.0.0.1", port: 0 });
      const { port } = bound as { port: number };
      url = `postgres://postgres@127.0.0.1:${port}/tripwire`;
      await writeFile(endpointFile, JSON.stringify({ url }), { mode: 0o600 });
    } else {
      const sockets = join(root, "sock");
      await privateDirectory(sockets);
      await pooler.listen({ path: join(sockets, ".s.PGSQL.5432") });
      url = `postgres:///tripwire?host=${encodeURIComponent(sockets)}&user=postgres`;
    }

    const opened = { db, pooler };
    return {
      mode: "local",
      url,
      async close() {
        await opened.pooler.close();
        await opened.db.close();
        await rm(endpointFile, { force: true });
        await releaseLock();
      },
    };
  } catch (error) {
    await pooler?.close().catch(() => {});
    await db?.close().catch(() => {});
    await releaseLock();
    throw error;
  }
}

export interface ExternalOptions {
  /** The oldest server major version the pinned engine release supports. */
  minimumMajor?: number;
}

/** Checks the owner's server before anything is spawned against it. */
export async function openExternal(
  url: string,
  options: ExternalOptions = {},
): Promise<Database> {
  await preflight(url, options);
  return { mode: "external", url, close: async () => {} };
}

export async function preflight(
  url: string,
  options: ExternalOptions = {},
): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    throw new DatabaseSetupError(
      "database_unreachable",
      `Cannot reach the database at ${describeTarget(url)}: ${reason(error)}`,
    );
  }
  try {
    const { rows } = await client.query<{
      can_create: boolean;
      version: string;
      database: string;
    }>(
      `select has_database_privilege(current_user, current_database(), 'CREATE') as can_create,
              current_setting('server_version_num') as version,
              current_database() as database`,
    );
    const facts = rows[0]!;
    if (!facts.can_create) {
      throw new DatabaseSetupError(
        "database_underprivileged",
        `The database user cannot create schemas in ${facts.database}. Grant it with: GRANT CREATE ON DATABASE "${facts.database}" TO <user>;`,
      );
    }
    const major = Math.floor(Number(facts.version) / 10_000);
    if (options.minimumMajor && major < options.minimumMajor) {
      throw new DatabaseSetupError(
        "database_too_old",
        `The database runs PostgreSQL ${major}; Tripwire needs ${options.minimumMajor} or newer.`,
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** Where a URL points, with any credentials left out. */
export function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const host =
      parsed.searchParams.get("host") ||
      `${parsed.hostname || "localhost"}${parsed.port ? `:${parsed.port}` : ""}`;
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    return `${host}${database ? `, database ${database}` : ""}`;
  } catch {
    return "the configured URL";
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Creates `path` if needed and makes it readable by its owner only. */
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

/**
 * Takes the database lock: a file created exclusively with this process's
 * id. A lock whose process is gone is replaced; a live one is refused.
 */
async function takeLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return async () => {
        const holder = await readFile(path, "utf8").catch(() => "");
        if (Number(holder.trim()) === process.pid)
          await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
      if (pid > 0 && isAlive(pid)) {
        throw new DatabaseSetupError(
          "database_locked",
          `database in use by process ${pid}`,
        );
      }
      await rm(path, { force: true });
    }
  }
  throw new DatabaseSetupError(
    "database_locked",
    "Could not take the database lock.",
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
