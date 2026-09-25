import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { relative, sep } from "node:path";
import { isApiPath } from "./paths";

/** Serves the built dashboard, falling back to index.html for its routes. */
export async function serveWeb(app: FastifyInstance, root: string) {
  await app.register(fastifyStatic, {
    root,
    setHeaders(reply, path) {
      // Only Vite's content-hashed assets are safe to cache forever.
      const hashed = relative(root, path).startsWith(`assets${sep}`);
      reply.header(
        "Cache-Control",
        hashed ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });

  app.setNotFoundHandler((request, reply) => {
    if (isDashboardRoute(request)) return reply.sendFile("index.html");
    return reply.code(404).send({
      statusCode: 404,
      error: "Not Found",
      message: `Route ${request.method}:${request.url} not found`,
    });
  });
}

/** Dashboard routes live in the browser; missing files are real 404s. */
function isDashboardRoute(request: FastifyRequest) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (isApiPath(request.url)) return false;
  const [path = ""] = request.url.split("?");
  if (path.startsWith("/assets/")) return false;
  const looksLikeFile = /\.[^/]+$/.test(path);
  return !looksLikeFile || (request.headers.accept ?? "").includes("text/html");
}
