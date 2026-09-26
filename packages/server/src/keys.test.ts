import type {
  Contract,
  EngineStatus,
  KeyDetail,
  KeyList,
  NewKey,
} from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "./app";
import { newKeystore } from "./engine/keystore";
import { isSigning } from "./keys";
import { ViewReads } from "./engine/reads";
import { STUB_VIEWS, StubEngine } from "./engine/stub";
import { GUARDIAN } from "./engine/stub-responses";
import { signIn, TEST_COST, testDatabase, testHome } from "./testing";

// Keys as Settings uses them: made, imported, unlocked and locked in the
// engine, with the passphrase passed through and never sent back.

const vault = "0x5555555555555555555555555555555555555555";
const directory = "/data/engine/keys";
const passphrase = "correct horse battery";

let app: FastifyInstance;
let pool: pg.Pool;
let stub: StubEngine;
const cleanup: (() => Promise<void>)[] = [];

const get = <T>(url: string) =>
  app.inject({ url: `/api/v1${url}` }).then((res) => res.json<T>());
const post = (url: string, payload: object = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload });
const put = (url: string, payload: object) =>
  app.inject({ method: "PUT", url: `/api/v1${url}`, payload });

beforeAll(async () => {
  const database = await testDatabase();
  const home = await testHome();
  pool = database.pool;
  stub = await StubEngine.open(pool);
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
          name: null,
          unlocked: true,
          balanceWei: "1000000000000000000",
          signing: true,
          neededBy: 0,
          // The stand-in's guardian names every key an operator.
          operatorOn: [vault],
          file: `${directory}/${made}.json`,
        },
      ],
    });
  });

  it("keeps one key: a second is refused, made or imported", async () => {
    const second = await post("/keys", { passphrase });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "one_key" });
    const { keystore } = await newKeystore("another one", 10);
    const imported = await post("/keys/import", {
      keystore,
      passphrase: "another one",
    });
    expect(imported.json()).toMatchObject({ code: "one_key" });
    expect((await get<KeyList>("/keys")).keys).toHaveLength(1);
  });

  it("counts the rules that need the signing key to act", async () => {
    const neededBy = async () =>
      (await get<KeyList>("/keys")).keys.map((k) => [k.unlocked, k.neededBy]);
    const rule = (action: string) => ({
      version: 1,
      name: `acts ${action}`,
      contract: vault,
      severity: "critical",
      when: "every_block",
      trip_when: {
        node: "compare",
        op: "gt",
        left: {
          node: "view_call",
          function: "totalSupply() returns (uint256)",
          args: [],
        },
        right: { node: "literal", value: "1" },
      },
      on_trip: { action },
    });
    const ids = [];
    for (const action of ["trip_global", "notify"]) {
      const res = await post("/rules", { rule: rule(action) });
      ids.push(res.json<{ id: string }>().id);
    }
    // The pause needs it; the notification does not.
    expect(await neededBy()).toEqual([[true, 1]]);
    await post(`/keys/${made}/lock`);
    expect(await neededBy()).toEqual([[false, 1]]);
    // Straight to the engine, leaving the dashboard's attempt limit alone.
    await stub.unlockKey(made, passphrase);
    for (const id of ids) {
      await app.inject({ method: "DELETE", url: `/api/v1/rules/${id}` });
    }
    expect(await neededBy()).toEqual([[true, 0]]);
  });

  it("imports a keystore made elsewhere, locked, once it opens", async () => {
    // The first key's file removed while Tripwire is stopped.
    const {
      rows: [first],
    } = await pool.query<{ keystore: unknown; created_at: Date }>(
      "DELETE FROM stub.keys WHERE address = $1 RETURNING keystore, created_at",
      [made],
    );
    expect(
      (
        await post("/keys/import", {
          keystore: { version: 3 },
          passphrase: "x",
        })
      ).statusCode,
    ).toBe(400);
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

    // The first file put back by hand: two keys, and neither signs.
    await pool.query(
      "INSERT INTO stub.keys (address, keystore, created_at) VALUES ($1, $2, $3)",
      [made, first!.keystore, first!.created_at],
    );
    const { keys } = await get<KeyList>("/keys");
    expect(keys.map((k) => [k.address, k.unlocked, k.signing])).toEqual([
      [made, true, false],
      [carried, false, false],
    ]);
  });

  it("refuses what is not a keystore, and what is far too large for one", async () => {
    // Checked before the one-key limit; a JSON object is the engine's to judge.
    for (const keystore of ["{", "42", "x".repeat(70_000)]) {
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

  it("follows a contract's guardian on the controller, and one that never registered", async () => {
    const guardianOf = async () =>
      (await get<Contract[]>("/contracts")).find((c) => c.address === vault)
        ?.controller;
    const next = `0x${"8".repeat(40)}`;
    await pool.query(
      `INSERT INTO stub.controller_events
         (block_number, block_hash, block_time, address, tx_hash, log_index, event_name, payload)
       VALUES (1e9, '0x', now(), '0xc0', '0x', 0, 'GuardianshipTransferred', $1)`,
      [
        JSON.stringify({
          guardedContract: vault,
          oldGuardian: GUARDIAN,
          newGuardian: next,
        }),
      ],
    );
    expect(await guardianOf()).toEqual({ guardian: next });
    await pool.query(
      "DELETE FROM stub.controller_events WHERE payload->>'guardedContract' = $1",
      [vault],
    );
    expect(await guardianOf()).toBeNull();
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
    // Later than anything the stand-in's guardian did.
    const later = 1e9;
    await event("OperatorAdded", vault, later + 10);
    await event("OperatorAdded", other, later + 11);
    await event("OperatorRemoved", other, later + 12);
    await event("OperatorAdded", `0x${"7".repeat(40)}`, later + 13);

    const { keys } = await get<KeyList>("/keys");
    expect(keys.find((k) => k.address === carried)?.operatorOn).toEqual([
      vault,
    ]);
    // Named on Other when it registered; the vault's grants went with its events.
    expect(keys.find((k) => k.address === made)?.operatorOn).toEqual([other]);
  });

  it("names a key, renames it, and forgets the name", async () => {
    const nameOf = async () =>
      (await get<KeyList>("/keys")).keys.find((k) => k.address === made)?.name;
    expect(
      (await put(`/keys/${made}/name`, { name: "  Pauser  " })).json(),
    ).toEqual({ address: made, name: "Pauser" });
    expect(await nameOf()).toBe("Pauser");
    await put(`/keys/${made}/name`, { name: "Hot wallet" });
    expect(await nameOf()).toBe("Hot wallet");
    await put(`/keys/${made}/name`, { name: "" });
    expect(await nameOf()).toBeNull();

    expect(
      (await put(`/keys/${made}/name`, { name: "x".repeat(61) })).json(),
    ).toMatchObject({ code: "invalid_name" });
    expect(
      (await put(`/keys/0x${"9".repeat(40)}/name`, { name: "Nobody" }))
        .statusCode,
    ).toBe(404);
  });

  it("shows what a key may do to the registered contracts", async () => {
    const owned = "0x4444444444444444444444444444444444444444";
    await post("/contracts", {
      address: owned,
      name: "Owned",
      abi: [
        {
          type: "function",
          name: "owner",
          inputs: [],
          outputs: [{ type: "address" }],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "hasRole",
          inputs: [{ type: "bytes32" }, { type: "address" }],
          outputs: [{ type: "bool" }],
          stateMutability: "view",
        },
      ],
    });
    const read = vi.spyOn(stub, "read");

    read.mockResolvedValueOnce([carried, "true"]);
    const detail = await get<KeyDetail>(`/keys/${carried}`);
    expect(read).toHaveBeenLastCalledWith([
      { address: owned, function: "owner() returns (address)", args: [] },
      {
        address: owned,
        function: "hasRole(bytes32,address) returns (bool)",
        args: [`0x${"0".repeat(64)}`, carried],
      },
    ]);
    expect(detail.key.address).toBe(carried);
    expect(detail.powers).toEqual([
      { contract: { address: owned, name: "Owned" }, power: "owner" },
      { contract: { address: owned, name: "Owned" }, power: "admin" },
      // The stand-in's guardian names every key an operator on registering.
      { contract: { address: owned, name: "Owned" }, power: "operator" },
      { contract: { address: vault, name: "Vault" }, power: "operator" },
    ]);
    expect(detail.powersProblem).toBeNull();

    read.mockRejectedValueOnce(new Error("engine unreachable"));
    const unread = await get<KeyDetail>(`/keys/${carried}`);
    expect(unread.powersProblem).toContain("engine unreachable");
    // The controller's grants come from its events, not a read.
    expect(unread.powers.map((p) => p.power)).toEqual(["operator", "operator"]);
    read.mockRestore();

    expect(
      (await app.inject({ url: `/api/v1/keys/0x${"9".repeat(40)}` }))
        .statusCode,
    ).toBe(404);
  });

  it("lists the transactions sent from a key, where the engine names the sender", async () => {
    const action = (tx: object) =>
      pool.query(
        `INSERT INTO stub.actions (kind, target, note, status, tx)
         VALUES ('trip_global', $1, 'drill', 'confirmed', $2)`,
        [vault, JSON.stringify(tx)],
      );
    await action({
      hash: "0xaa",
      from: carried,
      confirmed_block: 12,
      gas_used: "21000",
    });
    // Two keys, no sender: it cannot be told whose it was.
    await action({ hash: "0xbb" });
    // Built, never sent.
    await action({});

    const detail = await get<KeyDetail>(`/keys/${carried}`);
    // Ids and times are the stand-in's own.
    expect(
      detail.transactions.map(({ id, createdAt, ...rest }) => {
        expect(id).toMatch(/^\d+$/);
        expect(Date.parse(createdAt)).not.toBeNaN();
        return rest;
      }),
    ).toEqual([
      {
        kind: "action",
        reason: "drill",
        call: "pause (controller)",
        contract: { address: vault, name: "Vault" },
        status: "confirmed",
        hash: "0xaa",
        block: 12,
        gasUsed: "21000",
      },
    ]);
    expect(detail.unattributed).toBe(1);
    const other = await get<KeyDetail>(`/keys/${made}`);
    expect(other.transactions).toEqual([]);
    expect(other.unattributed).toBe(1);
    await pool.query("DELETE FROM stub.actions");
  });
});

describe("isSigning", () => {
  const key = (address: string) => ({ address, unlocked: true, balance: "0" });
  const a = `0x${"a".repeat(40)}`;
  const b = `0x${"b".repeat(40)}`;

  it("is the configured key, whatever else is on disk", () => {
    expect(isSigning(a, [key(a), key(b)], a.toUpperCase())).toBe(true);
    expect(isSigning(b, [key(a), key(b)], a)).toBe(false);
  });

  it("is the only key when none is configured, and none of several", () => {
    expect(isSigning(a, [key(a)], null)).toBe(true);
    expect(isSigning(a, [key(a), key(b)], null)).toBe(false);
  });
});
