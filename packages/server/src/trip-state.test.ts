import type { SetupState, TripStateItem } from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./app";
import { ViewReads } from "./engine/reads";
import { STUB_VIEWS, StubEngine } from "./engine/stub";
import { signIn, TEST_COST, testDatabase, testHome } from "./testing";

// What is paused now, after the stand-in sends a rule's response, and the
// first-run checklist as the Overview reads it.

const token = "0x5555555555555555555555555555555555555555";
const abi = [
  { type: "function", name: "pause", inputs: [], outputs: [] },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
];
const tripping = (name: string, onTrip: object) => ({
  version: 1,
  name,
  contract: token,
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
  on_trip: onTrip,
});
const confirmedPause = {
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
};

let now = Date.UTC(2026, 8, 1);
let app: FastifyInstance;
let stub: StubEngine;
const cleanup: (() => Promise<void>)[] = [];
const get = <T>(url: string) =>
  app.inject({ url: `/api/v1${url}` }).then((res) => res.json<T>());
const block = async () => {
  now += 12_000;
  await stub.tick();
};

beforeAll(async () => {
  const database = await testDatabase();
  const home = await testHome();
  stub = await StubEngine.open(database.pool, () => now, "send");
  app = await createServer({
    backend: {
      pool: database.pool,
      engine: {
        commands: stub,
        reads: new ViewReads(database.pool, STUB_VIEWS),
        events: stub,
        info: { chainId: 1, responseMode: "send", simulated: true },
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
});
afterAll(async () => {
  for (const step of cleanup) await step();
});

describe("the setup checklist", () => {
  it("ticks each step as its state appears, and stays dismissed", async () => {
    expect(await get<SetupState>("/setup")).toEqual({
      steps: {
        account: true,
        chain: true,
        contract: false,
        rule: false,
        channel: false,
      },
      dismissed: false,
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/contracts",
      payload: { address: token, name: "Token", abi },
    });
    for (const [name, onTrip] of [
      ["Pause and confirm", confirmedPause],
      ["Pause through the controller", { action: "trip_global" }],
    ] as const) {
      await app.inject({
        method: "POST",
        url: "/api/v1/rules",
        payload: { rule: tripping(name, onTrip) },
      });
    }
    expect((await get<SetupState>("/setup")).steps).toMatchObject({
      contract: true,
      rule: true,
    });
    await app.inject({ method: "POST", url: "/api/v1/setup/dismiss" });
    expect((await get<SetupState>("/setup")).dismissed).toBe(true);
  });
});

describe("what is paused now", () => {
  it("is nothing before any response lands", async () => {
    expect(await get<TripStateItem[]>("/trip-state")).toEqual([]);
  });

  it("lists a confirmed call and the controller's pause once sent", async () => {
    await block(); // trips, and sends at once
    await block(); // confirmed
    const paused = await get<TripStateItem[]>("/trip-state");
    const call = paused.find((p) => p.source === "verify");
    const controller = paused.find((p) => p.source === "controller");
    expect(call).toMatchObject({
      contract: { address: token, name: "Token" },
      scope: "function",
      function: "pause()",
      txHash: null,
      actor: null,
      rules: [{ name: "Pause and confirm" }],
    });
    expect(controller).toMatchObject({
      scope: "global",
      selector: null,
      function: null,
      actor: {
        is: "tripwire_response",
        rule: { name: "Pause through the controller" },
      },
      rules: [],
    });
    expect(controller!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
