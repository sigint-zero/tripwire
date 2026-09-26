import Fastify, { type FastifyInstance } from "fastify";
import { api, type Backend } from "./api";
import { guardRequests } from "./security";
import { serveWeb } from "./web";

export interface ServerOptions {
  /** Directory holding the built dashboard. Omit to serve the API only. */
  webRoot?: string;
  /** Host names besides localhost and IP addresses the server answers to. */
  allowedHosts?: string[];
  /** The database and engine the API serves from. Omit for health only. */
  backend?: Backend;
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
  if (options.webRoot) await serveWeb(app, options.webRoot);
  return app;
}
