import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
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

/** A server with the API backed by a test database and the stand-in. */
export async function testServer(
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  const database = await testDatabase();
  const app = await createServer({
    ...options,
    backend: { pool: database.pool, engine: await stubBackend(database.pool) },
  });
  app.addHook("onClose", () => database.close());
  return app;
}
