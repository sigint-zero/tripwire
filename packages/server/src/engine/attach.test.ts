import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../app";
import { migrate } from "../db/migrate";
import { signIn, TEST_COST, testHome } from "../testing";
import { loadEngineContract } from "./contract-files";
import { connectEngine } from "./index";

// The attach-mode suite: the application in
// process against a real engine run by hand, on one shared database and a
// local chain. scripts/attach-engine.sh starts the engine, the chain and
// the database and runs this file; without it, it is skipped. Any engine
// build can be attached, so an engine is proven here before it is pinned.

const env = process.env;
const attached = Boolean(env.TRIPWIRE_ATTACH_RPC && env.TRIPWIRE_ENGINE_URL);

// The rule language of the engine under test: its checkout's contract
// when given, else the pinned release's, which only an engine of the
// pinned version speaks (checked below).
const contract = attached ? await loadEngineContract(env) : null;

// anvil's first development account.
const DEV_KEY: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe.skipIf(!attached)("attached to a real engine", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let removeHome: () => Promise<void>;
  let target: Address;
  let abi: Abi;
  let send: (data: { functionName: string; args?: unknown[] }) => Promise<void>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: env.TRIPWIRE_DATABASE_URL, max: 4 });
    pool.on("error", () => {});
    await migrate(pool);
    const { home, remove } = await testHome();
    removeHome = remove;
    app = await createServer({
      home,
      passwordCost: TEST_COST,
      backend: { pool, engine: await connectEngine(pool, env) },
    });
    await signIn(app);

    const fixture = JSON.parse(
      await readFile(
        new URL("./fixtures/attach/AttachTarget.json", import.meta.url),
        "utf8",
      ),
    ) as { abi: Abi; bytecode: Hex };
    abi = fixture.abi;
    const account = privateKeyToAccount(DEV_KEY);
    const transport = http(env.TRIPWIRE_ATTACH_RPC);
    const chain = {
      id: Number(env.TRIPWIRE_CHAIN_ID ?? 31337),
      name: "anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [env.TRIPWIRE_ATTACH_RPC!] } },
    };
    const wallet = createWalletClient({ account, chain, transport });
    const client = createPublicClient({ chain, transport });
    const hash = await wallet.deployContract({
      abi,
      bytecode: fixture.bytecode,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    target = receipt.contractAddress!;
    // Rules are checked at the engine's head: wait until it has the
    // contract, so no check reads the address before its code exists.
    const deployed = Number(receipt.blockNumber);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { rows } = await pool
        .query<{ block: number | null }>(
          "SELECT max(block_number)::int AS block FROM api_v1.engine_status",
        )
        .catch(() => ({ rows: [{ block: null }] }));
      if ((rows[0]?.block ?? -1) >= deployed) break;
      if (Date.now() > deadline) throw new Error("the engine never followed");
      await new Promise((r) => setTimeout(r, 200));
    }
    send = async ({ functionName, args = [] }) => {
      const tx = await wallet.writeContract({
        address: target,
        abi,
        functionName,
        args,
      });
      await client.waitForTransactionReceipt({ hash: tx });
    };
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await removeHome?.();
  });

  const api = (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  /** Poll until `check` holds, mining nothing; the engine follows the chain. */
  const until = async (
    what: string,
    check: () => Promise<boolean>,
    seen: () => Promise<unknown> = () => Promise.resolve(null),
  ) => {
    const deadline = Date.now() + 30_000;
    while (!(await check())) {
      if (Date.now() > deadline) {
        throw new Error(`never: ${what}; saw ${JSON.stringify(await seen())}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  const ruleDoc = (name: string, extra: object = {}) => ({
    version: 1,
    name,
    contract: target,
    severity: "critical",
    when: "every_block",
    trip_when: {
      node: "compare",
      op: "gt",
      left: {
        node: "view_call",
        function: "value() returns (uint256)",
        args: [],
      },
      right: { node: "literal", value: "100" },
    },
    on_trip: { action: "notify" },
    ...extra,
  });

  it("reports the engine as attached and watching", async () => {
    await until("the engine watching", async () => {
      const body = (await api("GET", "/engine")).json<{
        runner: string;
        state: string;
      }>();
      return (
        body.runner === "attached" && ["ready", "degraded"].includes(body.state)
      );
    });
    const { version } = (await api("GET", "/engine")).json<{
      version: string | null;
    }>();
    expect(version, "the engine under test reports its own version").toBe(
      env.TRIPWIRE_ATTACH_ENGINE_VERSION,
    );
    if (contract?.version !== "checkout") {
      expect(
        contract?.version,
        "without its checkout, only the pinned release's contract describes the engine",
      ).toBe(version);
    }
  });

  it("registers the contract and stores a rule through the engine", async () => {
    const registered = await api("POST", "/contracts", {
      address: target,
      name: "attach target",
      abi,
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const stored = await api("POST", "/rules", {
      rule: ruleDoc("value above 100"),
      checkOnly: false,
    });
    expect(stored.statusCode, stored.body).toBe(201);
    const { id } = stored.json<{ id: string }>();
    const rule = (await api("GET", `/rules/${id}`)).json<{
      rule: { name: string };
    }>();
    expect(rule.rule.name).toBe("value above 100");
  });

  it("shows the violation the engine records", async () => {
    await send({ functionName: "set", args: [150n] });
    await until("a violation in the list", async () => {
      const body = (await api("GET", "/violations")).json<
        unknown[] | { violations: unknown[] }
      >();
      return (Array.isArray(body) ? body : body.violations).length > 0;
    });
  });

  it("refuses deleting a rule while its response is live", async () => {
    await send({ functionName: "set", args: [50n] });
    const stored = await api("POST", "/rules", {
      rule: ruleDoc("pause above 120", {
        trip_when: {
          node: "compare",
          op: "gt",
          left: {
            node: "view_call",
            function: "value() returns (uint256)",
            args: [],
          },
          right: { node: "literal", value: "120" },
        },
        on_trip: {
          action: "call",
          call: {
            function: "pause()",
            args: [],
            verify: {
              node: "compare",
              op: "eq",
              left: {
                node: "view_call",
                function: "paused() returns (bool)",
                args: [],
              },
              right: { node: "literal", value: "true" },
            },
          },
        },
      }),
      checkOnly: false,
    });
    expect(stored.statusCode, stored.body).toBe(201);
    const { id } = stored.json<{ id: string }>();
    await send({ functionName: "set", args: [200n] });
    await until(
      "a live response for the rule",
      async () => {
        const rows = (await api("GET", "/responses")).json<
          { rule: { id: string }; status: string }[]
        >();
        return rows.some(
          (r) =>
            r.rule.id === id &&
            ["pending", "awaiting_approval", "approved", "submitted"].includes(
              r.status,
            ),
        );
      },
      async () => ({
        api: (await api("GET", "/responses")).json<unknown>(),
        views: (
          await pool.query(
            "SELECT id, rule_id, status, error FROM api_v1.responses ORDER BY id",
          )
        ).rows,
        rules: (await pool.query("SELECT id, name, enabled FROM api_v1.rules"))
          .rows,
      }),
    );
    const deleted = await api("DELETE", `/rules/${id}`);
    expect(deleted.statusCode, deleted.body).toBe(409);
    expect((await api("GET", `/rules/${id}`)).statusCode).toBe(200);
  }, 60_000);

  it("takes `watch` exactly when the engine's rule language has it", async () => {
    const properties = contract!.ruleSchema.properties as object;
    const engineHasWatch = "watch" in properties;
    const stored = await api("POST", "/rules", {
      rule: ruleDoc("watching a feed", {
        watch: ["0x00000000000000000000000000000000000000f1"],
      }),
      checkOnly: false,
    });
    expect(stored.statusCode, stored.body).toBe(engineHasWatch ? 201 : 400);
  });
});
