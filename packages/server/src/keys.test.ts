import type { EngineStatus, KeyList, NewKey } from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./app";
import { newKeystore } from "./engine/keystore";
import { ViewReads } from "./engine/reads";
import { STUB_VIEWS, StubEngine } from "./engine/stub";
import { signIn, TEST_COST, testDatabase, testHome } from "./testing";

// Keys as Settings uses them: made, imported, unlocked and locked in the
// engine, with the passphrase passed through and never sent back.

const vault = "0x5555555555555555555555555555555555555555";
const directory = "/data/engine/keys";
const passphrase = "correct horse battery";

let app: FastifyInstance;
let pool: pg.Pool;
const cleanup: (() => Promise<void>)[] = [];

const get = <T>(url: string) =>
  app.inject({ url: `/api/v1${url}` }).then((res) => res.json<T>());
const post = (url: string, payload: object = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload });

beforeAll(async () => {
  const database = await testDatabase();
  const home = await testHome();
  pool = database.pool;
  const stub = await StubEngine.open(pool);
  app = await createServer({
    backend: {
      pool,
      engine: {
        commands: stub,
        reads: new ViewReads(pool, STUB_VIEWS),
        events: stub,
        info: { chainId: 1, responseMode: "prepare", simulated: true },
        keysDirectory: directory,
        close: () => Promise.resolve(),
      },
    },
    home: home.home,
    passwordCost: TEST_COST,
  });
  cleanup.push(
    () => app.close(),
    () => database.close(),
    () => home.remove(),
  );
  await signIn(app);
  await post("/contracts", { address: vault, name: "Vault", abi: [] });
});
afterAll(async () => {
  for (const step of cleanup) await step();
});

describe("keys", () => {
  let made: string;
  let carried: string;

  it("makes a key that can sign at once, and says where its file is", async () => {
    expect((await post("/keys", { passphrase: "too short" })).statusCode).toBe(
      400,
    );
    const res = await post("/keys", { passphrase });
    expect(res.statusCode).toBe(201);
    const key = res.json<NewKey>();
    made = key.address;
    expect(key.file).toBe(`${directory}/${made}.json`);
    expect(res.body).not.toContain(passphrase);

    expect(await get<KeyList>("/keys")).toEqual({
      directory,
      keys: [
        {
          address: made,
          unlocked: true,
          balanceWei: "0",
          signing: true,
          operatorOn: [],
          file: `${directory}/${made}.json`,
        },
      ],
    });
  });

  it("imports a keystore made elsewhere, locked, once it opens", async () => {
    const { address, keystore } = await newKeystore("carried over", 10);
    // Without the address field some tools leave out.
    const unnamed: Record<string, unknown> = { ...keystore };
    delete unnamed.address;
    const wrong = await post("/keys/import", {
      keystore: unnamed,
      passphrase: "not it",
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: "wrong_passphrase" });

    // As the file's text, the way a browser reads it.
    const res = await post("/keys/import", {
      keystore: JSON.stringify(unnamed),
      passphrase: "carried over",
    });
    expect(res.statusCode).toBe(201);
    carried = res.json<NewKey>().address;
    expect(carried).toBe(address);

    const again = await post("/keys/import", {
      keystore,
      passphrase: "carried over",
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "key_exists" });

    const { keys } = await get<KeyList>("/keys");
    expect(keys.map((k) => [k.address, k.unlocked, k.signing])).toEqual([
      [made, true, false],
      [carried, false, false],
    ]);
  });

  it("refuses what is not a keystore, and what is far too large for one", async () => {
    for (const keystore of ["{", { version: 3 }, "x".repeat(70_000)]) {
      const res = await post("/keys/import", { keystore, passphrase: "x" });
      expect(res.json()).toMatchObject({ code: "invalid_keystore" });
    }
  });

  it("unlocks and locks, and says so in the engine's health", async () => {
    const wrong = await post(`/keys/${carried}/unlock`, { passphrase: "no" });
    expect(wrong.json()).toMatchObject({ code: "wrong_passphrase" });
    expect(wrong.body).not.toContain("carried over");
    expect(
      (
        await post(
          `/keys/${carried.toUpperCase().replace("0X", "0x")}/unlock`,
          {
            passphrase: "carried over",
          },
        )
      ).json(),
    ).toEqual({ address: carried, unlocked: true });
    expect((await get<EngineStatus>("/engine")).health?.keys).toEqual({
      known: 2,
      unlocked: 2,
    });

    expect((await post(`/keys/${made}/lock`)).json()).toEqual({
      address: made,
      unlocked: false,
    });
    expect((await get<EngineStatus>("/engine")).health?.keys).toEqual({
      known: 2,
      unlocked: 1,
    });
    expect((await post("/keys/0x12/lock")).statusCode).toBe(404);
    expect((await post(`/keys/0x${"9".repeat(40)}/lock`)).json()).toMatchObject(
      { code: "not_found" },
    );
  });

  it("allows five tries a minute at unlocking a key", async () => {
    const tries = [];
    for (let i = 0; i < 6; i++) {
      tries.push(
        (await post(`/keys/${made}/unlock`, { passphrase: `guess ${i}` }))
          .statusCode,
      );
    }
    expect(tries).toEqual([400, 400, 400, 400, 400, 429]);
    // The limit is per key.
    expect(
      (await post(`/keys/${carried}/unlock`, { passphrase: "carried over" }))
        .statusCode,
    ).toBe(200);
  });

  it("names the registered contracts that make a key an operator", async () => {
    const event = (name: string, contract: string, block: number) =>
      pool.query(
        `INSERT INTO stub.controller_events
           (block_number, block_hash, block_time, address, tx_hash, log_index, event_name, payload)
         VALUES ($1, '0x', now(), '0xc0', '0x', 0, $2, $3)`,
        [
          block,
          name,
          JSON.stringify({
            guardedContract: contract,
            operator: carried,
            guardian: made,
          }),
        ],
      );
    // Granted on the vault; granted then removed on another registered
    // contract; granted on one this installation does not watch.
    const other = "0x6666666666666666666666666666666666666666";
    await post("/contracts", { address: other, name: "Other", abi: [] });
    await event("OperatorAdded", vault, 10);
    await event("OperatorAdded", other, 11);
    await event("OperatorRemoved", other, 12);
    await event("OperatorAdded", `0x${"7".repeat(40)}`, 13);

    const { keys } = await get<KeyList>("/keys");
    expect(keys.find((k) => k.address === carried)?.operatorOn).toEqual([
      vault,
    ]);
    expect(keys.find((k) => k.address === made)?.operatorOn).toEqual([]);
  });
});
