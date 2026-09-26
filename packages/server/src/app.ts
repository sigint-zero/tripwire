import { loadContent } from "@tripwire/mcp";
import Fastify, { type FastifyInstance } from "fastify";
import { AgentServices } from "./agent-services";
import { api, type Backend } from "./api";
import { Auth } from "./auth";
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
   * The application's data directory, where accounts, sessions and MCP
   * tokens are kept. Required with a backend: the API is never served
   * without authentication.
   */
  home?: string;
  /** Where the MCP server's teaching content is; beside the source by default. */
  mcpContentDir?: string;
  /** Terminate TLS in the server itself, and mark cookies Secure. */
  https?: { key: Buffer; cert: Buffer };
  /**
   * A reverse proxy terminates TLS: trust its X-Forwarded-Proto and
   * X-Forwarded-For. Without it those headers are ignored.
   */
  behindProxy?: boolean;
  /** log2 of scrypt's N for new password hashes; lowered only in tests. */
  passwordCost?: number;
}

export async function createServer(
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  if (options.backend && !options.home) {
    throw new Error(
      "A server with a backend needs a data directory for its accounts.",
    );
  }
  const app = Fastify({
    trustProxy: options.behindProxy ?? false,
    ...(options.https ? { https: options.https } : {}),
  }) as unknown as FastifyInstance;
  guardRequests(app, options.allowedHosts);
  const auth = options.home
    ? await Auth.open(options.home, { cost: options.passwordCost })
    : undefined;
  if (auth) app.addHook("onClose", () => auth.close());

  app.addHook("onError", (request, _reply, error, done) => {
    if ((error.statusCode ?? 500) >= 500) {
      console.error(`${request.method} ${request.url} failed:`, error);
    }
    done();
  });

  await app.register(api, {
    prefix: "/api/v1",
    backend: options.backend,
    auth,
  });
  if (options.backend && auth) {
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
      tokens: auth.tokens,
      version: VERSION,
    });
  }
  if (options.webRoot) await serveWeb(app, options.webRoot);
  return app;
}
