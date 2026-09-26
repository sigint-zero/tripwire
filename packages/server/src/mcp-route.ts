import {
  createMcpEndpoint,
  type Content,
  type McpServices,
} from "@tripwire/mcp";
import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { McpTokens } from "./auth/mcp-tokens";
import { refuse } from "./refuse";

// The MCP endpoint. It accepts an MCP token as a bearer credential and
// nothing else: a session cookie here is anonymous. The token's id and
// label ride along to the tools, which attribute everything to it.

/** Requests with a bad token allowed per client address per minute. */
const BAD_TOKENS_PER_MINUTE = 20;

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1] ?? null;
}

/** The Fastify request as the web-standard one the SDK serves. */
function toRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const hasBody = request.method === "POST" && request.body !== undefined;
  return new Request(`http://${request.host}${request.url}`, {
    method: request.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
  });
}

export const mcpRoute: FastifyPluginCallback<{
  services: McpServices;
  content: Content;
  tokens: McpTokens;
  version: string;
}> = (app, { services, content, tokens, version }, done) => {
  const endpoint = createMcpEndpoint(services, content, version, (error) =>
    app.log.warn(error),
  );
  app.addHook("onClose", () => endpoint.close());

  // A misconfigured agent retrying with a bad token should not fill the logs.
  const failures = new Map<string, number[]>();
  const limited = (address: string, reply: FastifyReply) => {
    const now = Date.now();
    const recent = (failures.get(address) ?? []).filter(
      (t) => now - t < 60_000,
    );
    failures.set(address, recent);
    if (recent.length < BAD_TOKENS_PER_MINUTE) return false;
    const wait = Math.ceil((recent[0]! + 60_000 - now) / 1000);
    void refuse(
      reply.header("Retry-After", String(wait)),
      429,
      "rate_limited",
      "Too many requests with an invalid token.",
    );
    return true;
  };

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      if (limited(request.ip, reply)) return reply;
      const token = bearer(request);
      const record = token ? await tokens.verify(token) : null;
      if (!token || !record) {
        failures.set(request.ip, [
          ...(failures.get(request.ip) ?? []),
          Date.now(),
        ]);
        if (token) {
          request.log.info({ address: request.ip }, "rejected MCP token");
        }
        return refuse(
          reply.header("WWW-Authenticate", 'Bearer realm="tripwire"'),
          401,
          "unauthenticated",
          "The MCP endpoint needs an MCP token: Authorization: Bearer twm_…",
        );
      }
      const response = await endpoint.fetch(toRequest(request), {
        authInfo: {
          token,
          clientId: record.id,
          scopes: [],
          extra: { label: record.label },
        },
        parsedBody: request.body,
      });
      return reply.send(response);
    },
  });

  done();
};
