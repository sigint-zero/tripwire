import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { basename } from "node:path";

/** Serves the built dashboard's files. */
export async function serveWeb(app: FastifyInstance, root: string) {
  await app.register(fastifyStatic, {
    root,
    setHeaders(reply, path) {
      // Asset file names are content-hashed; index.html must always revalidate.
      reply.header(
        "Cache-Control",
        basename(path) === "index.html"
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      );
    },
  });
}
