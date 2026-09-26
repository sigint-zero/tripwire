import type { StoredRuleCheck, Violation } from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./app";
import { ViewReads } from "./engine/reads";
import { STUB_VIEWS, StubEngine } from "./engine/stub";
import { signIn, TEST_COST, testDatabase, testHome } from "./testing";

// The stand-in records violations as the engine does; the application
// lists them and remembers which ones a person has acknowledged.

const token = "0x5555555555555555555555555555555555555555";
const rule = (name: string, op: string) => ({
  version: 1,
  name,
  contract: token,
  severity: "critical",
  when: "every_block",
  trip_when: {
    node: "compare",
    op,
    left: {
      node: "view_call",
      function: "totalSupply() returns (uint256)",
      args: [],
    },
    right: { node: "literal", value: "1" },
  },
  on_trip: { action: "notify" },
});

let clock = Date.UTC(2026, 8, 1);
let stub: StubEngine;
let app: FastifyInstance;
let tripping: string;

beforeAll(async () => {
  const database = await testDatabase();
  const home = await testHome();
  stub = await StubEngine.open(database.pool, () => clock);
  app = await createServer({
    backend: {
      pool: database.pool,
      engine: {
        commands: stub,
        reads: new ViewReads(database.pool, STUB_VIEWS),
        info: { chainId: 1, responseMode: "prepare", simulated: true },
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
  const add = (name: string, op: string) =>
    app
      .inject({
        method: "POST",
        url: "/api/v1/rules",
        payload: { rule: rule(name, op) },
      })
      .then((res) => res.json<StoredRuleCheck>().id);
  tripping = await add("Supply above one", "gt");
  await add("Supply below one", "lt");
  return async () => {
    await app.close();
    await database.close();
    await home.remove();
  };
});

const list = (query = "") =>
  app
    .inject({ url: `/api/v1/violations${query}` })
    .then((res) => res.json<Violation[]>());

describe("violations", () => {
  it("records a trip once per block, with its evidence", async () => {
    expect(await stub.tick()).toBe(1);
    expect(await stub.tick()).toBe(0);
    clock += 12_000;
    expect(await stub.tick()).toBe(1);

    const [newest, older] = await list();
    expect(newest).toMatchObject({
      ruleId: tripping,
      ruleName: "Supply above one",
      severity: "critical",
      contractAddress: token,
      kind: "tripped",
      evidence: { node: "compare", value: true },
      acknowledged: null,
    });
    expect(newest!.blockNumber).toBe(older!.blockNumber + 1);
  });

  it("filters by rule and contract, and pages by id", async () => {
    expect(await list(`?rule=${tripping}`)).toHaveLength(2);
    expect(
      await list(`?contract=${token.toUpperCase().replace("0X", "0x")}`),
    ).toHaveLength(2);
    expect(
      await list("?contract=0x4444444444444444444444444444444444444444"),
    ).toEqual([]);
    const [newest] = await list();
    const page = await list(`?before=${newest!.id}&limit=5`);
    expect(page.map((v) => v.id)).not.toContain(newest!.id);
    expect(page).toHaveLength(1);
  });

  it("refuses a malformed query", async () => {
    for (const query of ["?rule=abc", "?limit=0", "?open=maybe"]) {
      const res = await app.inject({ url: `/api/v1/violations${query}` });
      expect(res.statusCode).toBe(400);
    }
  });

  it("acknowledges once, and leaves it out of the open ones", async () => {
    const [newest] = await list();
    const ack = (note?: string) =>
      app
        .inject({
          method: "POST",
          url: `/api/v1/violations/${newest!.id}/acknowledge`,
          payload: note === undefined ? {} : { note },
        })
        .then((res) => res.json<Violation>());

    expect(
      (await ack("  Expected during the migration. ")).acknowledged,
    ).toMatchObject({
      by: expect.stringMatching(/^u_/) as unknown,
      note: "Expected during the migration.",
    });
    expect((await ack("Second thoughts")).acknowledged?.note).toBe(
      "Expected during the migration.",
    );
    const open = await list("?open=true");
    expect(open.map((v) => v.id)).not.toContain(newest!.id);
    expect(open).toHaveLength(1);
  });

  it("acknowledges a run together, or none of it", async () => {
    const ids = (await list("?open=true")).map((v) => v.id);
    const bulk = (payload: object) =>
      app.inject({
        method: "POST",
        url: "/api/v1/violations/acknowledge",
        payload,
      });
    const refused = await bulk({ ids: [...ids, "999999"] });
    expect(refused.statusCode).toBe(404);
    expect(await list("?open=true")).toHaveLength(ids.length);

    const res = await bulk({ ids, note: "Seen" });
    expect(res.json<Violation[]>().map((v) => v.acknowledged?.note)).toEqual(
      ids.map(() => "Seen"),
    );
    expect(await list("?open=true")).toEqual([]);
    expect((await bulk({ ids: [] })).statusCode).toBe(400);
  });

  it("answers 404 for a violation that does not exist", async () => {
    for (const url of ["/violations/999999", "/violations/abc"]) {
      const res = await app.inject({ url: `/api/v1${url}` });
      expect(res.statusCode).toBe(404);
    }
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/violations/999999/acknowledge",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("stops recording for a disabled rule", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/v1/rules/${tripping}`,
      payload: { enabled: false },
    });
    clock += 12_000;
    expect(await stub.tick()).toBe(0);
  });
});
