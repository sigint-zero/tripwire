import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shippedMigrations } from "./migrate";
import { databaseTarget, startDatabase, tripwireHome } from "./start";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tripwire-start-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const config = (database: unknown) =>
  writeFile(
    join(home, "config.json"),
    JSON.stringify({ version: 1, database }),
  );

describe("databaseTarget", () => {
  it("is local until first run has written a configuration", async () => {
    expect(await databaseTarget({ home, env: {} })).toEqual({ mode: "local" });
  });

  it("follows the file, resolving env: urls", async () => {
    await config({ mode: "external", url: "env:DB" });
    expect(
      await databaseTarget({ home, env: { DB: "postgres://h/db" } }),
    ).toEqual({ mode: "external", url: "postgres://h/db" });
    await expect(databaseTarget({ home, env: {} })).rejects.toThrow(
      "reads DB, which is not set",
    );
  });

  it("lets the flag, then the environment, override the file", async () => {
    await config({ mode: "local" });
    const env = { TRIPWIRE_DATABASE_URL: "postgres://env/db" };
    expect(await databaseTarget({ home, env })).toEqual({
      mode: "external",
      url: "postgres://env/db",
    });
    expect(
      await databaseTarget({ home, env, url: "postgres://flag/db" }),
    ).toEqual({ mode: "external", url: "postgres://flag/db" });
  });

  it("defaults the home directory", () => {
    expect(tripwireHome({ TRIPWIRE_HOME: "/data/tw" })).toBe("/data/tw");
    expect(tripwireHome({})).toMatch(/\.tripwire$/);
  });
});

describe("startDatabase", { timeout: 30_000 }, () => {
  it("migrates on first start and applies nothing on the next", async () => {
    const shipped = await shippedMigrations();
    const first = await startDatabase({ home, env: {} });
    expect(first.database.mode).toBe("local");
    expect(first.migrations.applied).toEqual(shipped.map((m) => m.version));
    await first.close();

    const second = await startDatabase({ home, env: {} });
    expect(second.migrations).toEqual({
      applied: [],
      version: first.migrations.version,
    });
    await second.close();
  });
});
