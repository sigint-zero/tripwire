import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  migrate,
  readLedger,
  shippedMigrations,
  type Migration,
} from "./migrate";
import { Pooler } from "./pooler";

// Migrations run against an in-memory database behind the same pooler
// local mode uses, so the runner meets the leasing it will meet there.

let db: PGlite;
let pooler: Pooler;
let url: string;
const pools: pg.Pool[] = [];

beforeEach(async () => {
  db = await PGlite.create();
  pooler = new Pooler(db);
  const endpoint = await pooler.listen({ host: "127.0.0.1", port: 0 });
  url = `postgres://postgres@127.0.0.1:${(endpoint as { port: number }).port}/tripwire`;
});

afterEach(async () => {
  for (const p of pools.splice(0)) await p.end().catch(() => {});
  await pooler.close();
  await db.close();
});

function pool() {
  const p = new pg.Pool({ connectionString: url, max: 1 });
  p.on("error", () => {});
  pools.push(p);
  return p;
}

describe("migrations", () => {
  it("applies the shipped files once, then nothing", async () => {
    const p = pool();
    const shipped = await shippedMigrations();

    const first = await migrate(p);
    expect(first.applied).toEqual(shipped.map((m) => m.version));
    const second = await migrate(p);
    expect(second.applied).toEqual([]);
    expect(second.version).toBe(first.version);

    const { rows } = await p.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'app' ORDER BY 1",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "channels",
      "contract_disables",
      "contract_sources",
      "deliveries",
      "dispatches",
      "local_notifications",
      "migrations",
      "notification_reads",
      "rule_prefs",
      "rule_submissions",
      "settings",
      "violation_acks",
    ]);
  });

  it("applies each file once when two processes start together", async () => {
    const [a, b] = await Promise.all([migrate(pool()), migrate(pool())]);
    expect([...a.applied, ...b.applied].sort()).toEqual(
      (await shippedMigrations()).map((m) => m.version),
    );
    const client = await pool().connect();
    expect((await readLedger(client)).size).toBe(a.version);
    client.release();
  });

  it("stops when an applied file was altered", async () => {
    const p = pool();
    await migrate(p);
    const altered: Migration[] = (await shippedMigrations()).map((m, i) =>
      i === 0 ? { ...m, checksum: "0".repeat(64) } : m,
    );
    await expect(migrate(p, altered)).rejects.toMatchObject({
      code: "migration_altered",
    });
  });

  it("stops when the database is newer than this application", async () => {
    const p = pool();
    await migrate(p);
    await p.query(
      "INSERT INTO app.migrations (version, name, checksum) VALUES (9999, '9999_future.sql', 'x')",
    );
    await expect(migrate(p)).rejects.toMatchObject({
      code: "app_schema_newer",
    });
  });

  it("rolls back a failing file and names it", async () => {
    const p = pool();
    const shipped = await shippedMigrations();
    const broken: Migration = {
      version: shipped.length + 1,
      name: `${String(shipped.length + 1).padStart(4, "0")}_broken.sql`,
      checksum: "b".repeat(64),
      sql: "CREATE TABLE app.half_done (v int); SELECT * FROM app.nothing_here;",
    };
    const error = await migrate(p, [...shipped, broken]).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "migration_failed" });
    expect((error as Error).message).toContain(broken.name);

    const { rows } = await p.query<{ exists: boolean }>(
      "SELECT to_regclass('app.half_done') IS NOT NULL AS exists",
    );
    expect(rows[0]?.exists).toBe(false);
    const client = await p.connect();
    expect([...(await readLedger(client)).keys()]).toEqual(
      shipped.map((m) => m.version),
    );
    client.release();
  });
});
