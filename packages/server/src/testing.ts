import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance, InjectOptions } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createServer, type ServerOptions } from "./app";
import { migrate } from "./db/migrate";
import { Pooler } from "./db/pooler";
import { stubBackend } from "./engine";

/**
 * A migrated in-memory database behind the same pooler local mode uses,
 * for tests. `close` tears it all down.
 */
export async function testDatabase() {
  const db = await PGlite.create();
  const pooler = new Pooler(db);
  const endpoint = await pooler.listen({ host: "127.0.0.1", port: 0 });
  const { port } = endpoint as { port: number };
  const pool = new pg.Pool({
    connectionString: `postgres://postgres@127.0.0.1:${port}/tripwire`,
    max: 1,
  });
  pool.on("error", () => {});
  await migrate(pool);
  return {
    pool,
    async close() {
      await pool.end();
      await pooler.close();
      await db.close();
    },
  };
}

/** Cheap password hashing, so tests do not spend seconds in scrypt. */
export const TEST_COST = 10;

export const TEST_ACCOUNT = {
  username: "tester",
  password: "correct horse battery staple",
};

/** A data directory for accounts and tokens, removed by `remove`. */
export async function testHome() {
  const home = await mkdtemp(join(tmpdir(), "tripwire-test-"));
  return { home, remove: () => rm(home, { recursive: true, force: true }) };
}

/**
 * Creates the first account and makes every later `inject` carry its
 * session, as a logged-in dashboard would. Returns the cookie.
 */
export async function signIn(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: TEST_ACCOUNT,
  });
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const inject = app.inject.bind(app) as (
    options: InjectOptions,
  ) => ReturnType<FastifyInstance["inject"]>;
  app.inject = ((options: InjectOptions | string) => {
    const opts = typeof options === "string" ? { url: options } : options;
    return inject({ ...opts, headers: { cookie, ...opts.headers } });
  }) as FastifyInstance["inject"];
  return cookie;
}

/** A signed-in server with the API backed by a test database and the stand-in. */
export async function testServer(
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  const [database, { home, remove }] = await Promise.all([
    testDatabase(),
    testHome(),
  ]);
  const app = await createServer({
    ...options,
    home,
    passwordCost: TEST_COST,
    backend: { pool: database.pool, engine: await stubBackend(database.pool) },
  });
  app.addHook("onClose", async () => {
    await database.close();
    await remove();
  });
  await signIn(app);
  return app;
}
