import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type CallToolResult,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Content } from "./content";
import { ToolError, type Agent, type McpServices } from "./types";

// The MCP server: the teaching layer as instructions, resources and one
// prompt, and four tools. It is stateless: every request gets a fresh
// instance, and the only identity is the token the request carried.

const GUIDES = [
  {
    name: "method",
    title: "How to find the rules for a contract",
    description:
      "The procedure: understand the contract, ask the five questions, look outward, set thresholds from evidence, size windows, write it down, check before submitting. Read this first.",
  },
  {
    name: "rule-language",
    title: "The rule language",
    description:
      "A primer on the rule document with one example per node type. The full JSON schema is at tripwire://schema/rule.",
  },
  {
    name: "metrics",
    title: "Historical metrics",
    description:
      "Each metric: what it measures, window semantics, warm-up, and worked numbers.",
  },
  {
    name: "examples",
    title: "Starting points by contract kind",
    description:
      "Complete rule documents for common contract kinds, with when to use each and what to change.",
  },
  {
    name: "pitfalls",
    title: "Pitfalls",
    description:
      "The ways rules raise false alarms or miss incidents, each with its symptom and fix.",
  },
] as const;

const json = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

/** Runs a tool, turning a refusal into an error result the model can act on. */
async function answer(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await work());
  } catch (error) {
    if (error instanceof ToolError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: error.code, message: error.message, ...error.details },
              null,
              2,
            ),
          },
        ],
      };
    }
    throw error;
  }
}

/** One server instance, for one request from one agent. */
export function createMcpServer(
  services: McpServices,
  content: Content,
  agent: Agent,
  version: string,
): McpServer {
  const server = new McpServer(
    { name: "tripwire", version },
    { instructions: content.instructions },
  );

  server.registerTool(
    "list_contracts",
    {
      title: "List contracts",
      description:
        "Workflow step 3: every contract this installation watches, with whether a person has disabled it, how many rules it has, and whether any is tripped. Start here, then call get_contract for the one you are working on.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => answer(() => services.listContracts()),
  );

  server.registerTool(
    "get_contract",
    {
      title: "Read a contract",
      description:
        "Workflow step 4: one contract in full. Its view functions (each with the `call` form a view_call takes), mutators and events with signatures exactly as rules name them; the live value of every no-argument view at the chain head; the addresses it depends on; and its stored source. Pass `source` as a file path to read that file.",
      inputSchema: z.object({
        contract: z
          .string()
          .min(1)
          .describe("The contract's id, address or name."),
        source: z
          .string()
          .default("list")
          .describe(
            '"none", "list" (file paths and sizes, the default), or a file path for its content.',
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ contract, source }) =>
      answer(() => services.getContract(contract, source)),
  );

  server.registerTool(
    "list_rules",
    {
      title: "List rules",
      description:
        "Workflow step 5: the rules already mapped onto a contract (or all contracts), each as the canonical document the engine evaluates, its English sentence and its detection state. Read these before drafting so you never propose a rule that already exists.",
      inputSchema: z.object({
        contract: z
          .string()
          .optional()
          .describe("The contract's id, address or name; omit for all."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ contract }) => answer(() => services.listRules(contract)),
  );

  server.registerTool(
    "submit_rule",
    {
      title: "Check or submit a rule",
      description:
        "Workflow steps 7 and 8. With check_only: true, the engine validates the document, evaluates it once at the chain head and returns the rule read back as a sentence, every value it read, whether it would trip now, how long it warms up and whether it duplicates an existing rule; nothing is stored. Repeat until it is clean and the sentence says what you meant. Without check_only the rule is stored disabled and notify-only for a person to review and enable; on_trip.action must be notify.",
      inputSchema: z.object({
        rule: z
          .record(z.string(), z.unknown())
          .describe(
            "The rule document, as tripwire://guide/rule-language describes. Its `contract` is the contract's address.",
          ),
        display_decimals: z
          .number()
          .int()
          .min(0)
          .max(77)
          .optional()
          .describe(
            "Decimals the rule's reads are shown with, e.g. the token's decimals().",
          ),
        check_only: z
          .boolean()
          .default(false)
          .describe("True to check without storing."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => answer(() => services.submitRule(input, agent)),
  );

  for (const guide of GUIDES) {
    const uri = `tripwire://guide/${guide.name}`;
    server.registerResource(
      guide.name,
      uri,
      {
        title: guide.title,
        description: guide.description,
        mimeType: "text/markdown",
      },
      () => ({
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text: content.guides[guide.name],
          },
        ],
      }),
    );
  }
  server.registerResource(
    "rule-schema",
    "tripwire://schema/rule",
    {
      title: "Rule schema",
      description: "The JSON schema of a rule document, version 1.",
      mimeType: "application/schema+json",
    },
    () => ({
      contents: [
        {
          uri: "tripwire://schema/rule",
          mimeType: "application/schema+json",
          text: content.schema,
        },
      ],
    }),
  );

  server.registerPrompt(
    "propose_rules",
    {
      title: "Propose rules for a contract",
      description:
        "Studies one registered contract and proposes the rules worth watching, each checked against the chain before it is submitted.",
      argsSchema: z.object({
        contract: z.string().describe("The contract's address or name."),
      }),
    },
    ({ contract }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: content.prompt.replaceAll("{{contract}}", contract),
          },
        },
      ],
    }),
  );

  return server;
}

/** The agent a request's validated token names. */
function agentOf(auth: AuthInfo | undefined): Agent {
  const label = auth?.extra?.label;
  if (!auth || typeof label !== "string") {
    throw new Error("An MCP request reached the server without a token.");
  }
  return { tokenId: auth.clientId, label };
}

/**
 * The HTTP face of the server, for the application to mount behind its
 * token check: it passes the token's id as `clientId` and its label as
 * `extra.label`.
 */
export function createMcpEndpoint(
  services: McpServices,
  content: Content,
  version: string,
  onerror?: (error: Error) => void,
): McpHttpHandler {
  return createMcpHandler(
    (ctx) => createMcpServer(services, content, agentOf(ctx.authInfo), version),
    { onerror },
  );
}
