import type { RuleCheck, SavedRule } from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testServer } from "./testing";

const vault = "0x83F20F44975D03b1b09e64809B757c47f942BEeA";
const read = (fn: string) => ({
  node: "view_call",
  function: `${fn} returns (uint256)`,
  args: [],
});
const floor = {
  version: 1,
  name: "totalAssets floor",
  contract: vault,
  severity: "critical",
  when: "every_block",
  trip_when: {
    node: "compare",
    op: "lt",
    left: read("totalAssets()"),
    right: { node: "literal", value: "1" },
  },
  on_trip: { action: "notify" },
};

let app: FastifyInstance;
beforeAll(async () => {
  app = await testServer();
  // Rules belong to registered contracts.
  await app.inject({
    method: "POST",
    url: "/api/v1/contracts",
    payload: { address: vault, name: "Vault", abi: [] },
  });
  return () => app.close();
});
afterEach(() => vi.restoreAllMocks());

const submit = (rule: object, checkOnly?: boolean) =>
  app.inject({
    method: "POST",
    url: "/api/v1/rules",
    payload: { rule, checkOnly },
  });

describe("checking a rule", () => {
  it("evaluates it at the current block and reads it back", async () => {
    const res = await submit(floor, true);
    expect(res.statusCode).toBe(200);
    const check = res.json<RuleCheck>();
    expect(check).toMatchObject({
      valid: true,
      issues: [],
      sentence:
        "On every block, notify when totalAssets() falls below 1 (critical).",
      warmupSeconds: 0,
      duplicateOf: null,
      simulated: true,
    });
    expect(check.evaluation?.wouldTripNow).toBe(false);
    expect(check.evaluation?.reads.map((r) => r.call)).toEqual([
      "totalAssets()",
    ]);
  });

  it("says when a rule would trip right now", async () => {
    const res = await submit(
      { ...floor, trip_when: { ...floor.trip_when, op: "gt" } },
      true,
    );
    expect(res.json<RuleCheck>().evaluation?.wouldTripNow).toBe(true);
  });

  it("never trips while a metric warms up, and says for how long", async () => {
    const drop = {
      ...floor,
      trip_when: {
        node: "compare",
        op: "ge",
        left: {
          node: "metric",
          metric: "windowed_drop",
          of: read("totalAssets()"),
          window: { seconds: 3_600 },
        },
        right: { node: "literal", value: "0" },
      },
    };
    const check = (await submit(drop, true)).json<RuleCheck>();
    expect(check.evaluation?.wouldTripNow).toBe(false);
    expect(check.warmupSeconds).toBe(3_600);
  });

  it("reports every problem with its location, and stores nothing", async () => {
    const res = await submit(
      {
        ...floor,
        severity: "urgent",
        trip_when: {
          ...floor.trip_when,
          right: { node: "literal", value: "one" },
        },
      },
      true,
    );
    expect(res.statusCode).toBe(200);
    const check = res.json<RuleCheck>();
    expect(check.valid).toBe(false);
    expect(check.issues.map((i) => i.path)).toEqual([
      "/severity",
      "/trip_when/right/value",
    ]);
    const list = await app.inject({ url: "/api/v1/rules" });
    expect(list.json()).toEqual([]);
  });
});

describe("storing a rule", () => {
  it("stores it enabled and lists it", async () => {
    const res = await submit(floor);
    expect(res.statusCode).toBe(201);
    const stored = res.json<RuleCheck & { id: string; stored: boolean }>();
    expect(stored).toMatchObject({ valid: true, stored: true });

    const list = await app.inject({ url: "/api/v1/rules" });
    const saved = list.json<SavedRule[]>().find((r) => r.id === stored.id);
    expect(saved).toMatchObject({
      rule: floor,
      enabled: true,
      origin: "dashboard",
      sentence: stored.sentence,
    });
  });

  it("stores a rule that calls the contract's own function", async () => {
    const res = await submit({
      ...floor,
      name: "Pause on empty vault",
      on_trip: {
        action: "call",
        call: { function: "pause()", args: [] },
        cooldown_seconds: 300,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<RuleCheck>().sentence).toBe(
      "On every block, call pause() when totalAssets() falls below 1 (critical, 5m cooldown).",
    );
  });

  it("refuses an identical rule, whatever its name", async () => {
    const res = await submit({
      ...floor,
      name: "Another name",
      severity: "info",
      contract: vault.toLowerCase(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "duplicate" });
  });

  it("refuses a second rule with the same name on the contract", async () => {
    const res = await submit({
      ...floor,
      trip_when: { ...floor.trip_when, op: "le" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "name_taken" });
  });

  it("refuses an invalid rule with its issues", async () => {
    const res = await submit({ ...floor, name: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "invalid_rule",
      issues: [{ path: "/name", message: "is required" }],
    });
  });

  it("refuses a rule for a contract that is not registered", async () => {
    const other = "0x4444444444444444444444444444444444444444";
    for (const checkOnly of [true, false]) {
      const res = await submit({ ...floor, contract: other }, checkOnly);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "contract_not_registered" });
    }
  });

  it("rejects a body that is not a submission", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rules",
      payload: { checkOnly: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("the engine", () => {
  it("reports its chain and how trips are carried out", async () => {
    const res = await app.inject({ url: "/api/v1/engine" });
    expect(res.json()).toEqual({
      chainId: 1,
      responseMode: "prepare",
      simulated: true,
    });
  });
});

describe("ABI lookup", () => {
  const url = `/api/v1/contracts/${vault}/abi`;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  it("merges a proxy's implementation ABI", async () => {
    const proxy = "0x1111111111111111111111111111111111111111";
    const impl = "0x2222222222222222222222222222222222222222";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return Promise.resolve(
        target.includes(impl)
          ? json({
              match: "match",
              abi: [{ type: "function", name: "totalAssets", inputs: [] }],
              compilation: { name: "Vault" },
            })
          : json({
              match: "match",
              abi: [
                {
                  type: "function",
                  name: "upgradeTo",
                  inputs: [{ type: "address" }],
                },
              ],
              compilation: { name: "Proxy" },
              proxyResolution: {
                isProxy: true,
                implementations: [{ address: impl }],
              },
            }),
      );
    });
    const res = await app.inject({ url: `/api/v1/contracts/${proxy}/abi` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      chainId: 1,
      name: "Vault",
      implementation: { address: impl, name: "Vault" },
    });
    expect(res.json<{ abi: unknown[] }>().abi).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    // Looked up on the engine's chain.
    const first = fetch.mock.calls[0]?.[0];
    expect(typeof first === "string" ? first : "").toContain(
      `/contract/1/${proxy}`,
    );
  });

  it("answers 404 for an unverified contract", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ match: null }, 404));
    const res = await app.inject({ url });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ code: string; message: string }>();
    expect(body.code).toBe("not_verified");
    expect(body.message).toMatch(/No verified contract/);
  });

  it("answers 502 when Sourcify is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const other = "0x3333333333333333333333333333333333333333";
    const res = await app.inject({ url: `/api/v1/contracts/${other}/abi` });
    expect(res.statusCode).toBe(502);
  });

  it("rejects a malformed address", async () => {
    const res = await app.inject({ url: "/api/v1/contracts/0x12/abi" });
    expect(res.statusCode).toBe(400);
  });
});
