import type {
  ManualActionItem,
  NotificationPage,
  Readiness,
  ResponseTest,
  StoredRuleCheck,
  TripStateItem,
} from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { encodeFunctionData, parseAbi } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./app";
import { ViewReads } from "./engine/reads";
import { STUB_VIEWS, StubEngine } from "./engine/stub";
import { CONTROLLER, GUARDIAN } from "./engine/stub-responses";
import { signIn, TEST_COST, testDatabase, testHome } from "./testing";

// A contract's response readiness, and pausing it by hand, against the
// stand-in's controller: it registers every contract, and its guardian
// names every key an operator.

const vault = "0x5555555555555555555555555555555555555555";
const abi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  { type: "function", name: "pause", inputs: [], outputs: [] },
];
const pausing = {
  version: 1,
  name: "Pause on supply",
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
  on_trip: { action: "trip_global" },
};

let now = Date.UTC(2026, 8, 1);
let app: FastifyInstance;
let stub: StubEngine;
let pool: pg.Pool;
const cleanup: (() => Promise<void>)[] = [];

const get = <T>(url: string) =>
  app.inject({ url: `/api/v1${url}` }).then((res) => res.json<T>());
const post = (url: string, payload: object = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload });
const readiness = async () =>
  (await get<Readiness[]>(`/readiness?contract=${vault}`))[0]!;
const step = (r: Readiness, name: string) =>
  r.steps.find((s) => s.step === name);

beforeAll(async () => {
  const database = await testDatabase();
  const home = await testHome();
  pool = database.pool;
  stub = await StubEngine.open(pool, () => now, "prepare");
  app = await createServer({
    backend: {
      pool,
      engine: {
        commands: stub,
        reads: new ViewReads(pool, STUB_VIEWS),
        events: stub,
        info: { chainId: 1, responseMode: "prepare", simulated: true },
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
  await post("/contracts", { address: vault, name: "Vault", abi });
});
afterAll(async () => {
  for (const s of cleanup) await s();
});

describe("readiness", () => {
  let ruleId: string;

  it("starts with nothing ready but the mode", async () => {
    const r = await readiness();
    expect(r).toMatchObject({ address: vault, name: "Vault", rules: [] });
    expect(r.steps.map((s) => [s.step, s.state])).toEqual([
      ["signing_key", "todo"],
      ["rules", "todo"],
      ["permission", "not_applicable"],
      ["least_power", "not_applicable"],
      ["mode", "done"],
    ]);
  });

  it("ticks each step as the key, the rule and its test arrive", async () => {
    await post("/keys", { passphrase: "correct horse battery" });
    ruleId = (await post("/rules", { rule: pausing })).json<StoredRuleCheck>()
      .id;
    let r = await readiness();
    // A controller pause adds registration and the operator grant.
    expect(r.steps.map((s) => [s.step, s.state])).toEqual([
      ["signing_key", "done"],
      ["rules", "done"],
      ["registered", "done"],
      ["operator", "done"],
      ["permission", "todo"],
      ["least_power", "done"],
      ["mode", "done"],
    ]);
    expect(step(r, "registered")!.detail).toContain(GUARDIAN.slice(0, 6));

    const test = (await post(`/readiness/${ruleId}/test`)).json<ResponseTest>();
    expect(test).toMatchObject({
      ok: true,
      revertReason: null,
      gasEstimate: 48_213,
      function: "tripGlobal(address)",
      args: [vault],
      balanceWei: "1000000000000000000",
    });
    r = await readiness();
    expect(step(r, "permission")!.state).toBe("done");
    expect(r.rules).toEqual([
      expect.objectContaining({ id: ruleId, action: "trip_global", test }),
    ]);
  });

  it("shows the guardian's call when the key is not an operator, and the failing test", async () => {
    const { rows } = await pool.query<{ address: string }>(
      "SELECT address FROM stub.keys",
    );
    const key = rows[0]!.address;
    await pool.query(
      `INSERT INTO stub.controller_events
         (block_number, block_hash, block_time, address, tx_hash, log_index, event_name, payload)
       VALUES (1e9, '0x', now(), $1, '0x', 0, 'OperatorRemoved', $2)`,
      [
        CONTROLLER,
        JSON.stringify({
          guardedContract: vault,
          operator: key,
          guardian: GUARDIAN,
        }),
      ],
    );
    const test = (await post(`/readiness/${ruleId}/test`)).json<ResponseTest>();
    expect(test).toMatchObject({
      ok: false,
      revertReason: "caller is not the guardian or an operator",
    });
    const r = await readiness();
    expect(step(r, "operator")!.state).toBe("todo");
    expect(step(r, "permission")!.detail).toBe(
      "Pause on supply: caller is not the guardian or an operator.",
    );
    expect(r.guardianCall).toEqual({
      to: CONTROLLER,
      value: "0",
      data: encodeFunctionData({
        abi: parseAbi(["function addOperator(address,address)"]),
        args: [vault, key as `0x${string}`],
      }),
      from: GUARDIAN,
    });
    expect(r.guardianCall!.data.startsWith("0x8a1af4c4")).toBe(true);
  });

  it("refuses to test a rule that only notifies", async () => {
    const notify = (
      await post("/rules", {
        rule: {
          ...pausing,
          name: "Only tell me",
          on_trip: { action: "notify" },
        },
      })
    ).json<StoredRuleCheck>().id;
    const res = await post(`/readiness/${notify}/test`);
    expect(res.statusCode).toBe(400);
    expect((await post("/readiness/404/test")).statusCode).toBe(404);
  });
});

describe("pausing by hand", () => {
  it("pauses through the controller, confirms, and says who asked", async () => {
    // The key is an operator again.
    await pool.query(
      "DELETE FROM stub.controller_events WHERE event_name = 'OperatorRemoved'",
    );
    const res = await post(`/contracts/${vault}/actions`, {
      controller: "pause",
      scope: "contract",
      note: "Draining, pausing now",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<ManualActionItem>()).toMatchObject({
      kind: "trip_global",
      target: vault,
      status: "submitted",
      note: "tester: Draining, pausing now",
    });
    now += 12_000;
    await stub.tick();
    expect(await get<TripStateItem[]>("/trip-state")).toEqual([
      expect.objectContaining({ scope: "global", source: "controller" }),
    ]);
    const feed = await get<NotificationPage>("/notifications?kind=response");
    // The same block also trips the rule; the pause by hand is its own row.
    expect(feed.items.find((i) => i.title.includes("by hand"))).toMatchObject({
      title: "Vault: pause by hand confirmed",
      text: expect.stringMatching(
        /^“tester: Draining, pausing now”/,
      ) as unknown,
    });

    await post(`/contracts/${vault}/actions`, {
      controller: "unpause",
      scope: "contract",
    });
    now += 12_000;
    await stub.tick();
    expect(await get<TripStateItem[]>("/trip-state")).toEqual([]);
  });

  it("gives the wallet call for a function of the contract's own", async () => {
    const res = await post(`/contracts/${vault}/actions`, {
      call: { function: "pause()", args: [] },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({
      code: "not_available",
      wallet: { to: vault, value: "0", data: "0x8456cb59" },
    });
  });

  it("refuses what it cannot send", async () => {
    const refused = async (payload: object) =>
      (await post(`/contracts/${vault}/actions`, payload)).json<{
        code: string;
      }>().code;
    expect(await refused({ controller: "pause", scope: "function" })).toBe(
      "invalid_action",
    );
    expect(
      await refused({ call: { function: "setCap(uint256)", args: [] } }),
    ).toBe("invalid_action");
    await pool.query(
      "DELETE FROM stub.controller_events WHERE event_name = 'Registered'",
    );
    expect(await refused({ controller: "pause", scope: "contract" })).toBe(
      "not_on_controller",
    );
    expect(
      (
        await post(`/contracts/0x${"9".repeat(40)}/actions`, {
          controller: "pause",
          scope: "contract",
        })
      ).statusCode,
    ).toBe(404);
  });
});
