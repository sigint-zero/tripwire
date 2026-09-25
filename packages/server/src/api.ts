import type { FastifyPluginCallback } from "fastify";

export const api: FastifyPluginCallback = (app, _options, done) => {
  app.get("/health", () => ({ status: "ok" }));
  done();
};
