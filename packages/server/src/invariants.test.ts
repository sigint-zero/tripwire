import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "./app";
import { preview } from "./mock-engine";

const vault = "0x83F20F44975D03b1b09e64809B757c47f942BEeA";
const read = (method: string) =>
  ({ type: "view_call", contract: vault, method }) as const;
const floor = {
  kind: "expression",
  condition: {
    type: "compare",
    op: "gte",
    left: read("totalAssets()"),
    right: { type: "literal", value: "1" },
  },
} as const;

let app: FastifyInstance;
beforeAll(async () => {
  app = await createServer();
  return () => app.close();
});
afterEach(() => vi.restoreAllMocks());

const post = (url: string, payload: object) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload });

describe("rule preview", () => {
  it("previews a valid rule with the values it compares", async () => {
    const res = await post("/invariants/preview", floor);
    expect(res.statusCode).toBe(200);
    const body = res.json<ReturnType<typeof preview>>();
    expect(body).toMatchObject({ holds: true, simulated: true });
    expect(body.terms.map((t) => t.label)).toEqual(["totalAssets", "1"]);
  });

  it("explains why a rule is invalid", async () => {
    const res = await post("/invariants/preview", {
      ...floor,
      condition: {
        ...floor.condition,
        right: { type: "literal", value: "1.5" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "invalid_rule",
      issues: [
        { path: "condition.right.value", message: "must be a whole number" },
      ],
    });
  });

  it("reports a breaking comparison", () => {
    const result = preview({
      ...floor,
      condition: { ...floor.condition, op: "lt" },
    });
    expect(result.holds).toBe(false);
    expect(result.detail).toMatch(/past the limit/);
  });
});

describe("invariants", () => {
  it("creates an invariant and lists it", async () => {
    const draft = {
      name: "Vault floor",
      chainId: 1,
      contract: vault,
      rule: floor,
      response: {
        mode: "alert",
        scope: { type: "contract" },
        cooldownSecs: 300,
      },
    };
    const created = await post("/invariants", draft);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ ...draft, enabled: true });

    const list = await app.inject({ url: "/api/v1/invariants" });
    expect(list.json()).toContainEqual(created.json());
  });

  it("rejects a draft without a name", async () => {
    const res = await post("/invariants", {
      chainId: 1,
      contract: vault,
      rule: floor,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("ABI lookup", () => {
  const url = `/api/v1/contracts/1/${vault}/abi`;
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
    const res = await app.inject({ url: `/api/v1/contracts/1/${proxy}/abi` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: "Vault",
      implementation: { address: impl, name: "Vault" },
    });
    expect(res.json<{ abi: unknown[] }>().abi).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
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
    const res = await app.inject({ url: `/api/v1/contracts/10/${vault}/abi` });
    expect(res.statusCode).toBe(502);
  });

  it("rejects a malformed address", async () => {
    const res = await app.inject({ url: "/api/v1/contracts/1/0x12/abi" });
    expect(res.statusCode).toBe(400);
  });
});
