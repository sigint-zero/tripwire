import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { SavedRule } from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./app";
import { McpTokens } from "./auth/mcp-tokens";
import { stubBackend } from "./engine";
import { signIn, TEST_COST, testDatabase } from "./testing";

// An agent's whole path through the MCP endpoint, over HTTP with the
// reference client: its token, the four tools, and the guards on what it
// may store.

const vault = "0x1111111111111111111111111111111111111111";
const unknown = "0x4444444444444444444444444444444444444444";
const abi = [
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "asset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [{ name: "ids", type: "uint256[]" }],
    outputs: [],
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
];
const floor = (name: string, op = "lt", action = "notify") => ({
  version: 1,
  name,
  contract: vault,
  severity: "critical",
  when: "every_block",
  trip_when: {
    node: "compare",
    op,
    left: {
      node: "view_call",
      function: "totalAssets() returns (uint256)",
      args: [],
    },
    right: {
      node: "view_call",
      function: "totalSupply() returns (uint256)",
      args: [],
    },
  },
  on_trip: { action },
});

let app: FastifyInstance;
let url: URL;
let tokens: McpTokens;
let token: string;
let database: Awaited<ReturnType<typeof testDatabase>>;

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "tripwire-mcp-"));
  database = await testDatabase();
  app = await createServer({
    backend: { pool: database.pool, engine: await stubBackend(database.pool) },
    home,
    passwordCost: TEST_COST,
  });
  await signIn(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as { port: number };
  url = new URL(`http://127.0.0.1:${port}/mcp`);
  tokens = new McpTokens(home);
  token = (await tokens.create({ label: "laptop agent" })).token;
  await app.inject({
    method: "POST",
    url: "/api/v1/contracts",
    payload: { address: vault, name: "Treasury Vault", abi },
  });
  await database.pool.query(
    `INSERT INTO app.contract_sources (address, verified, compiler, files, fetched_from)
     VALUES ($1, true, '0.8.24', $2, 'sourcify')`,
    [
      vault,
      JSON.stringify([{ path: "src/Vault.sol", content: "contract Vault {}" }]),
    ],
  );
  return async () => {
    await app.close();
    await database.close();
    await rm(home, { recursive: true, force: true });
  };
});

async function agent(bearer = token) {
  const client = new Client({ name: "test agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }),
  );
  return client;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const client = await agent();
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { error: result.isError === true, body: JSON.parse(text) as never };
}

describe("the MCP endpoint", () => {
  it("answers only a current MCP token", async () => {
    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post({})).status).toBe(401);
    expect(
      (await post({ authorization: "Bearer twm_not-a-real-token" })).status,
    ).toBe(401);
    // A dashboard session opens nothing here.
    expect((await post({ cookie: "tripwire_session=abc" })).status).toBe(401);
    await expect(agent("twm_wrong")).rejects.toThrow();
  });

  it("refuses a token as soon as it is revoked", async () => {
    const spare = await tokens.create({ label: "spare" });
    await (await agent(spare.token)).listTools();
    await tokens.revoke("spare");
    await expect(agent(spare.token)).rejects.toThrow();
  });
});

describe("reading", () => {
  it("lists the watched contracts", async () => {
    const { body } = await call("list_contracts");
    expect(body).toEqual([
      {
        id: expect.any(String) as unknown,
        name: "Treasury Vault",
        address: vault,
        chain_id: 1,
        active: true,
        rule_count: 0,
        tripped: false,
        has_source: true,
      },
    ]);
  });

  it("shows a contract as rules name it, with its live state", async () => {
    const { body } = await call("get_contract", { contract: "treasury vault" });
    const view = body as {
      abi: Record<string, { signature: string; call?: string }[]>;
      state: { values: { function: string; value: string }[] };
      linked: { function: string; address: string }[];
      source: { files: unknown[]; content: null };
    };
    expect(view.abi.views).toContainEqual(
      expect.objectContaining({
        signature: "totalAssets()",
        call: "totalAssets() returns (uint256)",
      }),
    );
    expect(view.abi.mutators).toContainEqual({
      signature: "settle(uint256[])",
      inputs: ["uint256[]"],
      unsupported:
        "array or tuple parameters are not available in language version 1",
    });
    expect(view.abi.events).toEqual([
      {
        signature:
          "OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
      },
    ]);
    expect(
      view.state.values.find((v) => v.function === "totalAssets()")?.value,
    ).toMatch(/^\d+$/);
    expect(view.linked).toEqual([
      {
        function: "asset()",
        address: expect.stringMatching(/^0x[0-9a-f]{40}$/) as unknown,
        registered_as: null,
      },
    ]);
    expect(view.source).toMatchObject({
      verified: true,
      files: [{ path: "src/Vault.sol", bytes: 17 }],
      content: null,
    });
  });

  it("serves a source file, and says when a path is wrong", async () => {
    const file = await call("get_contract", {
      contract: vault,
      source: "src/Vault.sol",
    });
    expect(file.body).toMatchObject({
      source: { content: "contract Vault {}" },
    });
    const missing = await call("get_contract", {
      contract: vault,
      source: "src/Nope.sol",
    });
    expect(missing).toMatchObject({
      error: true,
      body: { error: "not_found" },
    });
  });

  it("says when no contract matches", async () => {
    const result = await call("get_contract", { contract: "Nothing" });
    expect(result).toMatchObject({ error: true, body: { error: "not_found" } });
  });
});

describe("submitting", () => {
  it("checks a draft without storing it", async () => {
    const { body } = await call("submit_rule", {
      rule: floor("Assets cover shares"),
      check_only: true,
    });
    expect(body).toMatchObject({
      valid: true,
      sentence:
        "On every block, notify when totalAssets() falls below totalSupply() (critical).",
      evaluation: { would_trip_now: expect.any(Boolean) as unknown },
      duplicate_of: null,
    });
    expect(body).not.toHaveProperty("stored");
    expect((await call("list_rules")).body).toEqual([]);
  });

  it("returns every problem with a draft", async () => {
    const { error, body } = await call("submit_rule", {
      rule: { ...floor(""), severity: "loud" },
    });
    expect(error).toBe(false);
    expect(body).toMatchObject({ valid: false });
    expect(
      (body as { issues: { path: string }[] }).issues.map((i) => i.path).sort(),
    ).toEqual(["/name", "/severity"]);
  });

  it("proposes detection only, never a response", async () => {
    const result = await call("submit_rule", {
      rule: floor("Pause when short", "lt", "trip_global"),
    });
    expect(result).toMatchObject({
      error: true,
      body: { error: "response_not_allowed" },
    });
  });

  it("works only on contracts a person registered", async () => {
    const result = await call("submit_rule", {
      rule: { ...floor("Elsewhere"), contract: unknown },
    });
    expect(result).toMatchObject({
      error: true,
      body: { error: "contract_not_registered" },
    });
  });

  it("stores a rule disabled, attributed to the agent", async () => {
    const { body } = await call("submit_rule", {
      rule: floor("Assets cover shares"),
      display_decimals: 18,
    });
    expect(body).toMatchObject({
      valid: true,
      stored: true,
      next: "This rule is disabled until a person enables it in the dashboard.",
    });
    const id = (body as { id: string }).id;
    const saved = (
      await app.inject({ url: `/api/v1/rules/${id}` })
    ).json<SavedRule>();
    expect(saved).toMatchObject({
      enabled: false,
      origin: { mcp: "laptop agent" },
      display: { decimals: 18, unit: null },
    });

    const listed = (await call("list_rules", { contract: vault })).body;
    expect(listed).toMatchObject([
      {
        id,
        enabled: false,
        origin: { mcp: "laptop agent" },
        status: "disabled",
      },
    ]);
  });

  it("stores nothing that duplicates a rule, whatever its name", async () => {
    const { body } = await call("submit_rule", {
      rule: floor("Same statement, new name"),
    });
    expect(body).toMatchObject({ duplicate_of: expect.any(String) as unknown });
    expect(body).not.toHaveProperty("stored");
  });

  it("limits how many rules a token stores in an hour", async () => {
    await database.pool.query(
      "INSERT INTO app.settings (key, value) VALUES ('mcp.submissions_per_hour', '1')",
    );
    const result = await call("submit_rule", {
      rule: floor("Assets above shares", "gt"),
    });
    expect(result).toMatchObject({
      error: true,
      body: { error: "rate_limited" },
    });
  });
});
