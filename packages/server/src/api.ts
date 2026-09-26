import type { FastifyPluginCallback } from "fastify";
import { AbiLookup, abiRoutes } from "./abi";
import { contractRoutes } from "./contracts";
import { MockEngine } from "./mock-engine";
import { ruleRoutes } from "./rules";

export const api: FastifyPluginCallback = (app, _options, done) => {
  const engine = new MockEngine();
  const lookup = new AbiLookup(engine.info.chainId);

  app.get("/health", () => ({ status: "ok" }));
  app.get("/engine", () => engine.info);
  app.register(abiRoutes, { lookup });
  app.register(contractRoutes, { engine, lookup });
  app.register(ruleRoutes, { engine });

  done();
};
