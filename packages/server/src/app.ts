import { loadContent } from "@tripwire/mcp";
import Fastify, { type FastifyInstance } from "fastify";
import { AgentServices } from "./agent-services";
import { api, type Backend } from "./api";
import { McpTokens } from "./auth/mcp-tokens";
import { mcpRoute } from "./mcp-route";
import { RuleService } from "./rule-service";
import { guardRequests } from "./security";
import { AppStore } from "./store";
import { serveWeb } from "./web";

/** Reported to agents as the MCP server's version. */
const VERSION = "0.0.0";

export interface ServerOptions {
  /** Directory holding the built dashboard. Omit to serve the API only. */
  webRoot?: string;
  /** Host names besides localhost and IP addresses the server answers to. */
  allowedHosts?: string[];
  /** The database and engine the API serves from. Omit for health only. */
  backend?: Backend;
  /**
   * The application's data directory. With a backend, it enables the MCP
   * endpoint, whose tokens are kept here.
   */
  home?: string;
  /** Where the MCP server's teaching content is; beside the source by default. */
  mcpContentDir?: string;
}

export async function createServer(
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify();
  guardRequests(app, options.allowedHosts);

  app.addHook("onError", (request, _reply, error, done) => {
    if ((error.statusCode ?? 500) >= 500) {
      console.error(`${request.method} ${request.url} failed:`, error);
    }
    done();
  });

  await app.register(api, { prefix: "/api/v1", backend: options.backend });
  if (options.backend && options.home) {
    const { pool, engine } = options.backend;
    const store = new AppStore(pool);
    const rules = new RuleService(
      engine.commands,
      engine.reads,
      store,
      engine.info.simulated,
    );
    await app.register(mcpRoute, {
      services: new AgentServices({ ...engine, store, rules }),
      content: await loadContent(options.mcpContentDir),
      tokens: new McpTokens(options.home),
      version: VERSION,
    });
  }
  if (options.webRoot) await serveWeb(app, options.webRoot);
  return app;
}
