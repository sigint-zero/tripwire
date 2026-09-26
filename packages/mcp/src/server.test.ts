import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { loadContent } from "./content";
import { createMcpEndpoint } from "./server";
import { ToolError, type Agent, type McpServices } from "./types";

// The protocol face, driven by the reference client as an agent host would.

const submitted: { input: unknown; agent: Agent }[] = [];
const services: McpServices = {
  listContracts: () =>
    Promise.resolve([
      {
        id: "1",
        name: "Vault",
        address: "0x1111111111111111111111111111111111111111",
        chain_id: 1,
        active: true,
        rule_count: 0,
        tripped: false,
        has_source: false,
      },
    ]),
  getContract: (contract) =>
    Promise.reject(new ToolError("not_found", `No contract "${contract}".`)),
  listRules: () => Promise.resolve([]),
  submitRule: (input, agent) => {
    submitted.push({ input, agent });
    return Promise.resolve({
      valid: true,
      issues: [],
      sentence: "On every block, notify when x() falls below 1 (warning).",
      evaluation: {
        block: 1,
        would_trip_now: false,
        warming: false,
        error: null,
        reads: [],
      },
      warmup_seconds: 0,
      duplicate_of: null,
    });
  },
};

async function connect() {
  const endpoint = createMcpEndpoint(services, await loadContent(), "test");
  const client = new Client({ name: "test agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) =>
        endpoint.fetch(new Request(url, init), {
          authInfo: {
            token: "twm_x",
            clientId: "t_1",
            scopes: [],
            extra: { label: "laptop agent" },
          },
        }),
    }),
  );
  return client;
}

const text = (result: { content: unknown }) =>
  JSON.parse(
    (result.content as { type: string; text: string }[])[0]!.text,
  ) as unknown;

describe("the MCP server", () => {
  it("teaches before anything else: instructions, guides, schema and a prompt", async () => {
    const client = await connect();
    expect(client.getInstructions()).toMatch(/^Tripwire watches/);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "tripwire://guide/examples",
      "tripwire://guide/method",
      "tripwire://guide/metrics",
      "tripwire://guide/pitfalls",
      "tripwire://guide/rule-language",
      "tripwire://schema/rule",
    ]);
    const method = await client.readResource({
      uri: "tripwire://guide/method",
    });
    expect(method.contents[0]).toMatchObject({ mimeType: "text/markdown" });
    const prompt = await client.getPrompt({
      name: "propose_rules",
      arguments: { contract: "Vault" },
    });
    const message = prompt.messages[0]?.content as { text: string };
    expect(message.text).toContain('"Vault"');
    expect(message.text).not.toContain("{{contract}}");
  });

  it("offers exactly four tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_contract",
      "list_contracts",
      "list_rules",
      "submit_rule",
    ]);
  });

  it("answers a tool with JSON the model can read", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "list_contracts",
      arguments: {},
    });
    expect(text(result)).toMatchObject([{ name: "Vault", chain_id: 1 }]);
  });

  it("turns a refusal into an error result with its code", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "get_contract",
      arguments: { contract: "Nope" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({
      error: "not_found",
      message: 'No contract "Nope".',
    });
  });

  it("submits as the agent whose token the request carried", async () => {
    const client = await connect();
    await client.callTool({
      name: "submit_rule",
      arguments: { rule: { version: 1 }, check_only: true },
    });
    expect(submitted.at(-1)).toEqual({
      input: { rule: { version: 1 }, check_only: true },
      agent: { tokenId: "t_1", label: "laptop agent" },
    });
  });
});
