import type { ContractDetail } from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "./app";
import { stubBackend } from "./engine";
import { ViewReads } from "./engine/reads";
import { signIn, TEST_COST, testDatabase, testHome } from "./testing";

// What the application keeps beside the engine, and how it behaves at the
// boundary.

const proxy = "0x1111111111111111111111111111111111111111";
const implementation = "0x2222222222222222222222222222222222222222";
const pasted = "0x3333333333333333333333333333333333333333";

let database: Awaited<ReturnType<typeof testDatabase>>;
let app: FastifyInstance;

let home: Awaited<ReturnType<typeof testHome>>;

beforeAll(async () => {
  database = await testDatabase();
  home = await testHome();
  app = await createServer({
    backend: { pool: database.pool, engine: await stubBackend(database.pool) },
    home: home.home,
    passwordCost: TEST_COST,
  });
  await signIn(app);
  return async () => {
    await app.close();
    await database.close();
    await home.remove();
  };
});
afterEach(() => vi.restoreAllMocks());

const sourceOf = async (address: string) =>
  (
    await database.pool.query<{
      verified: boolean;
      compiler: string | null;
      implementation: string | null;
      files: { path: string }[];
      fetched_from: string;
    }>(
      "SELECT verified, compiler, implementation, files, fetched_from FROM app.contract_sources WHERE address = $1",
      [address],
    )
  ).rows[0];

describe("registering", () => {
  it("keeps the verified source, and sends only the ABI to the engine", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const body = url.includes(proxy)
        ? {
            match: "exact_match",
            abi: [{ type: "function", name: "upgradeTo", inputs: [] }],
            compilation: { name: "Proxy", compilerVersion: "0.8.24" },
            proxyResolution: {
              isProxy: true,
              implementations: [{ address: implementation, name: "Vault" }],
            },
            sources: { "src/Proxy.sol": { content: "contract Proxy {}" } },
          }
        : {
            match: "exact_match",
            abi: [{ type: "function", name: "deposit", inputs: [] }],
            compilation: { name: "Vault" },
          };
      return Promise.resolve(new Response(JSON.stringify(body)));
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/contracts",
      payload: { address: proxy, name: "Vault" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<ContractDetail>()).toMatchObject({
      source: "verified",
      implementation: { address: implementation },
    });
    expect(await sourceOf(proxy)).toEqual({
      verified: true,
      compiler: "0.8.24",
      implementation,
      files: [{ path: "src/Proxy.sol", content: "contract Proxy {}" }],
      fetched_from: "sourcify",
    });
  });

  it("keeps no source for a pasted ABI", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/contracts",
      payload: { address: pasted, name: "Pasted", abi: [] },
    });
    expect(res.json<ContractDetail>().source).toBe("pasted");
    expect(await sourceOf(pasted)).toBeUndefined();
  });
});

describe("before the engine has created its views", () => {
  it("answers that the engine is starting", async () => {
    const engine = await stubBackend(database.pool);
    const other = await testHome();
    const starting = await createServer({
      backend: {
        pool: database.pool,
        engine: { ...engine, reads: new ViewReads(database.pool, "api_v1") },
      },
      home: other.home,
      passwordCost: TEST_COST,
    });
    await signIn(starting);
    const res = await starting.inject({ url: "/api/v1/contracts" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "engine_starting" });
    await starting.close();
    await other.remove();
  });
});

describe("the schema boundary", () => {
  it("never names the engine's private schema in the application's SQL", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = [
      ...(await readdir(join(root, "src"), { recursive: true }))
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(root, "src", f)),
      ...(await readdir(join(root, "migrations"))).map((f) =>
        join(root, "migrations", f),
      ),
    ];
    const naming = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|SCHEMA)\s+engine\./i;
    const offenders: string[] = [];
    for (const file of files) {
      if (naming.test(await readFile(file, "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
