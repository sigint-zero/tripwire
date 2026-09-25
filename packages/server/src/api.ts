import type { FastifyPluginAsync } from "fastify";

export const api: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({ status: "ok" }));
};
