import Fastify, { type FastifyInstance } from "fastify";
import { api } from "./api";
import { serveWeb } from "./web";

export interface ServerOptions {
  /** Directory holding the built dashboard. Omit to serve the API only. */
  webRoot?: string;
}

export async function createServer(
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(api, { prefix: "/api/v1" });
  if (options.webRoot) await serveWeb(app, options.webRoot);

  app.setNotFoundHandler((request, reply) => {
    // Dashboard routes live in the browser, so they all get index.html.
    if (
      options.webRoot &&
      request.method === "GET" &&
      !request.url.startsWith("/api/")
    ) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({
      statusCode: 404,
      error: "Not Found",
      message: `Route ${request.method}:${request.url} not found`,
    });
  });

  return app;
}
