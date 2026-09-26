import type {
  ResponseCounts,
  ResponseItem,
  StoredRuleCheck,
  Violation,
} from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import { toFunctionSelector } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./app";
import { ViewReads } from "./engine/reads";
import { STUB_VIEWS, StubEngine } from "./engine/stub";
import { CONTROLLER } from "./engine/stub-responses";
import { signIn, TEST_COST, testDatabase, testHome } from "./testing";

// A rule that pauses on chain: the stand-in stages a response when it
// trips, a person approves or rejects it, and it runs to a final status.

const token = "0x5555555555555555555555555555555555555555";
const pausing = (name: string, onTrip: object) => ({
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

async function setUp(mode: "prepare" | "send") {
  let now = Date.UTC(2026, 8, 1);
  const database = await testDatabase();
  const home = await testHome();
  const stub = await StubEngine.open(database.pool, () => now, mode);
  const app = await createServer({
    backend: {
      pool: database.pool,
      engine: {
        commands: stub,
        reads: new ViewReads(database.pool, STUB_VIEWS),
        events: stub,
        info: { chainId: 1, responseMode: mode, simulated: true },
        close: () => Promise.resolve(),
      },
    },
    home: home.home,
    passwordCost: TEST_COST,
  });
  await signIn(app);
  await app.inject({
    method: "POST",
    url: "/api/v1/contracts",
    payload: { address: token, name: "Token", abi: [] },
  });
  const addRule = (name: string, onTrip: object) =>
    app
      .inject({
        method: "POST",
        url: "/api/v1/rules",
        payload: { rule: pausing(name, onTrip) },
      })
      .then((res) => res.json<StoredRuleCheck>().id);
  return {
    app,
    stub,
    addRule,
    /** The next simulated block. */
    block: async (seconds = 12) => {
      now += seconds * 1000;
      await stub.tick();
    },
    close: async () => {
      await app.close();
      await database.close();
      await home.remove();
    },
  };
}

const get = <T>(app: FastifyInstance, url: string) =>
  app.inject({ url: `/api/v1${url}` }).then((res) => res.json<T>());
const post = (app: FastifyInstance, url: string, payload: object = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload });

describe("responses in prepare mode", () => {
  let t: Awaited<ReturnType<typeof setUp>>;
  let ruleId: string;
  beforeAll(async () => {
    t = await setUp("prepare");
    ruleId = await t.addRule("Pause on supply", { action: "trip_global" });
    await t.addRule("Only tell me", { action: "notify" });
  });
  afterAll(() => t.close());

  it("holds a built transaction for approval when the rule trips", async () => {
    await t.block();
    const waiting = await get<ResponseItem[]>(
      t.app,
      "/responses?status=waiting",
    );
    expect(waiting).toHaveLength(1);
    const [held] = waiting;
    expect(held).toMatchObject({
      status: "awaiting_approval",
      action: "trip_global",
      mode: "prepare",
      rule: { id: ruleId, name: "Pause on supply" },
      contract: { address: token, name: "Token" },
      violation: { kind: "tripped" },
      tx: {
        to: CONTROLLER,
        function: "tripGlobal(address)",
        args: [token],
        maxFeeGwei: "30",
        maxPriorityFeeGwei: "2",
        maxCostWei: "1950000000000000",
        rebuilt: false,
        attempts: [],
      },
    });
    expect(await get<ResponseCounts>(t.app, "/responses/counts")).toEqual({
      waiting: 1,
      inFlight: 0,
    });

    // The violation names what was done about it.
    const [violation] = await get<Violation[]>(
      t.app,
      `/violations?rule=${ruleId}`,
    );
    expect(violation!.response).toEqual({
      id: held!.id,
      status: "awaiting_approval",
    });
  });

  it("stages one live response per rule, however often it trips", async () => {
    await t.block();
    await t.block();
    expect(await get<ResponseItem[]>(t.app, "/responses")).toHaveLength(1);
  });

  it("sends an approved response, once", async () => {
    const [held] = await get<ResponseItem[]>(t.app, "/responses");
    const approved = await post(t.app, `/responses/${held!.id}/approve`);
    expect(approved.json<ResponseItem>().status).toBe("approved");
    const again = await post(t.app, `/responses/${held!.id}/approve`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      code: "not_waiting",
      message: expect.stringContaining("approved") as unknown,
    });

    await t.block();
    const sent = await get<ResponseItem>(t.app, `/responses/${held!.id}`);
    expect(sent.status).toBe("submitted");
    expect(sent.tx!.attempts).toHaveLength(1);
    await t.block();
    const [done] = await get<ResponseItem[]>(
      t.app,
      "/responses?status=history",
    );
    expect(done).toMatchObject({
      id: held!.id,
      status: "confirmed",
      tx: { gasUsed: "48213" },
    });
    expect(done!.tx!.block).toBeGreaterThan(done!.tx!.attempts[0]!.block!);
  });

  it("waits out the quiet period, then rejects with a reason", async () => {
    await t.block();
    expect(
      await get<ResponseItem[]>(t.app, "/responses?status=waiting"),
    ).toEqual([]);
    await t.block(601);
    const [held] = await get<ResponseItem[]>(
      t.app,
      "/responses?status=waiting",
    );
    const rejected = await post(t.app, `/responses/${held!.id}/reject`, {
      reason: "  Known issue ",
    });
    expect(rejected.json()).toMatchObject({
      status: "abandoned",
      error: "Rejected: Known issue",
    });
    expect(
      (await post(t.app, `/responses/${held!.id}/reject`)).statusCode,
    ).toBe(409);
  });

  it("answers unknown and malformed requests", async () => {
    expect(
      (await t.app.inject({ url: "/api/v1/responses/999" })).statusCode,
    ).toBe(404);
    expect((await post(t.app, "/responses/999/approve")).statusCode).toBe(404);
    expect(
      (await t.app.inject({ url: "/api/v1/responses?status=soon" })).statusCode,
    ).toBe(400);
    expect(
      (await post(t.app, "/responses/1/reject", { reason: "x".repeat(501) }))
        .statusCode,
    ).toBe(400);
  });
});

describe("responses in send mode", () => {
  it("sends at once, with no approval", async () => {
    const t = await setUp("send");
    await t.addRule("Pause withdraw", {
      action: "trip_function",
      function: "withdraw(uint256)",
    });
    await t.block();
    const [sent] = await get<ResponseItem[]>(t.app, "/responses");
    expect(sent).toMatchObject({
      status: "submitted",
      action: "trip_function",
      tx: {
        function: "trip(address,bytes4)",
        // The engine names the paused function by its selector.
        args: [token, toFunctionSelector("withdraw(uint256)")],
      },
    });
    await t.block();
    expect(
      (await get<ResponseItem>(t.app, `/responses/${sent!.id}`)).status,
    ).toBe("confirmed");
    await t.close();
  });
});
