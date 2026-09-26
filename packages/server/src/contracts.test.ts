import type {
  Contract,
  ContractDetail,
  SavedRule,
  StoredRuleCheck,
} from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "./app";

const vault = "0x83F20F44975D03b1b09e64809B757c47f942BEeA";
const token = "0x5555555555555555555555555555555555555555";
const abi = [{ type: "function", name: "totalAssets", inputs: [] }];

let app: FastifyInstance;
beforeAll(async () => {
  app = await createServer();
  return () => app.close();
});
afterEach(() => vi.restoreAllMocks());

const register = (payload: object) =>
  app.inject({ method: "POST", url: "/api/v1/contracts", payload });
const get = <T>(url: string) =>
  app.inject({ url: `/api/v1${url}` }).then((res) => res.json<T>());

const rule = (name: string, op: string) => ({
  version: 1,
  name,
  contract: token,
  severity: "warning",
  when: "every_block",
  trip_when: {
    node: "compare",
    op,
    left: { node: "view_call", function: "totalSupply()", args: [] },
    right: { node: "literal", value: "1" },
  },
  on_trip: { action: "notify" },
});
const addRule = (name: string, op: string) =>
  app
    .inject({
      method: "POST",
      url: "/api/v1/rules",
      payload: { rule: rule(name, op) },
    })
    .then((res) => res.json<StoredRuleCheck>());

describe("registering a contract", () => {
  it("looks up the verified ABI when none is given", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ match: "match", abi, compilation: { name: "Vault" } }),
      ),
    );
    const res = await register({ address: vault, name: "Treasury vault" });
    expect(res.statusCode).toBe(201);
    expect(res.json<ContractDetail>()).toMatchObject({
      address: vault.toLowerCase(),
      name: "Treasury vault",
      active: true,
      ruleCount: 0,
      source: "verified",
      implementation: null,
      abi,
    });
  });

  it("takes a pasted ABI without looking anything up", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const res = await register({ address: token, name: "Token", abi: [] });
    expect(res.statusCode).toBe(201);
    expect(res.json<Contract>().source).toBe("pasted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists registered contracts by name, without their ABIs", async () => {
    const list = await get<Contract[]>("/contracts");
    expect(list.map((c) => c.name)).toEqual(["Token", "Treasury vault"]);
    expect(list[0]).not.toHaveProperty("abi");
  });

  it("returns one contract with its ABI, by any casing of its address", async () => {
    const detail = await get<ContractDetail>(`/contracts/${vault}`);
    expect(detail.abi).toEqual(abi);
  });

  it("refuses a contract that is already registered", async () => {
    const res = await register({
      address: vault.toLowerCase(),
      name: "Again",
      abi: [],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "already_registered" });
  });

  it("needs a name", async () => {
    const other = "0x6666666666666666666666666666666666666666";
    const res = await register({ address: other, name: " ", abi: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "invalid_contract",
      issues: [{ path: "/name", message: "is required" }],
    });
  });

  it("answers 404 for an unverified contract with no ABI given", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ match: null }), { status: 404 }),
    );
    const other = "0x7777777777777777777777777777777777777777";
    const res = await register({ address: other, name: "Unknown" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "not_verified" });
  });

  it("answers 404 for a contract that is not registered", async () => {
    const res = await app.inject({
      url: "/api/v1/contracts/0x8888888888888888888888888888888888888888",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("disabling a contract", () => {
  it("switches its rules off together and restores exactly those", async () => {
    const first = await addRule("Supply floor", "lt");
    expect(first.enabled).toBe(true);

    const disabled = await app.inject({
      method: "POST",
      url: `/api/v1/contracts/${token}/disable`,
    });
    expect(disabled.json<Contract>()).toMatchObject({
      active: false,
      ruleCount: 1,
      enabledCount: 0,
    });

    // A rule added meanwhile starts disabled, so the contract stays quiet.
    const second = await addRule("Supply cap", "gt");
    expect(second.enabled).toBe(false);

    const enabled = await app.inject({
      method: "POST",
      url: `/api/v1/contracts/${token}/enable`,
    });
    expect(enabled.json<Contract>()).toMatchObject({
      active: true,
      ruleCount: 2,
      enabledCount: 1,
    });
    const rules = await get<SavedRule[]>(`/rules?contract=${token}`);
    expect(
      Object.fromEntries(rules.map((r) => [r.rule.name, r.enabled])),
    ).toEqual({
      "Supply floor": true,
      "Supply cap": false,
    });
  });

  it("lists only the contract's rules when asked", async () => {
    expect(await get<SavedRule[]>(`/rules?contract=${vault}`)).toEqual([]);
  });
});
