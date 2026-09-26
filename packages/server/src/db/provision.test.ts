import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSetupError } from "./errors";
import {
  describeTarget,
  openLocal,
  preflight,
  type Database,
} from "./provision";

let home: string;
const open: Database[] = [];
const pools: pg.Pool[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tripwire-db-"));
});

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.end().catch(() => {});
  for (const db of open.splice(0)) await db.close().catch(() => {});
  await rm(home, { recursive: true, force: true });
});

async function local() {
  const db = await openLocal({ home });
  open.push(db);
  return db;
}

function pool(url: string) {
  const p = new pg.Pool({ connectionString: url, max: 1 });
  p.on("error", () => {});
  pools.push(p);
  return p;
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe("local mode", () => {
  it("keeps its files private and serves the database at its URL", async () => {
    const db = await local();
    expect(await mode(join(home, "db"))).toBe(0o700);
    expect(await mode(join(home, "db", "data"))).toBe(0o700);
    expect(await mode(join(home, "db", "sock"))).toBe(0o700);

    const { rows } = await pool(db.url).query<{ one: number }>(
      "SELECT 1 AS one",
    );
    expect(rows[0]?.one).toBe(1);
  });

  it("refuses a second opening while the first holds the lock", async () => {
    await local();
    await expect(openLocal({ home })).rejects.toThrow(
      `database in use by process ${process.pid}`,
    );
  });

  it("replaces a lock left by a process that is gone", async () => {
    await local().then((db) => db.close());
    open.length = 0;
    await writeFile(join(home, "db", "lock"), "999999999\n");
    await expect(local()).resolves.toBeDefined();
  });

  it("keeps what was written across a close and reopen", async () => {
    const first = await local();
    const p = pool(first.url);
    await p.query("CREATE TABLE public.kept (v text)");
    await p.query("INSERT INTO public.kept VALUES ('still here')");
    await p.end();
    pools.length = 0;
    await first.close();
    open.length = 0;

    const second = await local();
    const { rows } = await pool(second.url).query<{ v: string }>(
      "SELECT v FROM public.kept",
    );
    expect(rows).toEqual([{ v: "still here" }]);
  });

  it("passes the external pre-flight, which names a too-old server", async () => {
    const db = await local();
    await expect(preflight(db.url)).resolves.toBeUndefined();
    await expect(preflight(db.url, { minimumMajor: 99 })).rejects.toMatchObject(
      { code: "database_too_old" },
    );
  });
});

describe("pre-flight", () => {
  it("reports an unreachable server without its credentials", async () => {
    const url = `postgres://owner:s3cret@127.0.0.1:1/tripwire`;
    const error = await preflight(url).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseSetupError);
    expect(error).toMatchObject({ code: "database_unreachable" });
    expect((error as Error).message).toContain(
      "127.0.0.1:1, database tripwire",
    );
    expect((error as Error).message).not.toContain("s3cret");
  });

  it("describes socket and host targets", () => {
    expect(describeTarget("postgres:///tripwire?host=%2Ftmp%2Fsock")).toBe(
      "/tmp/sock, database tripwire",
    );
    expect(describeTarget("postgresql://u:p@db.internal:6543/app")).toBe(
      "db.internal:6543, database app",
    );
  });
});
