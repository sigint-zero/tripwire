import { address, issuesOf } from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { lookupFailed, type AbiLookup } from "./abi";
import type { MockEngine } from "./mock-engine";
import { refuse } from "./refuse";

const registration = z.object({
  address,
  name: z.string().trim().min(1, "is required").max(80),
  abi: z.array(z.unknown()).optional(),
});

type ByAddress = { Params: { address: string } };

// Registering is where a person decides what Tripwire watches. Disabling a
// contract switches its rules off together; enabling it restores them.
export const contractRoutes: FastifyPluginCallback<{
  engine: MockEngine;
  lookup: AbiLookup;
}> = (app, { engine, lookup }, done) => {
  const notFound = (reply: Parameters<typeof refuse>[0]) =>
    refuse(
      reply,
      404,
      "not_found",
      "No contract is registered at this address.",
    );

  app.get("/contracts", () => engine.contracts());

  app.get<ByAddress>(
    "/contracts/:address",
    (request, reply) =>
      engine.contract(request.params.address) ?? notFound(reply),
  );

  app.post("/contracts", async (request, reply) => {
    const body = registration.safeParse(request.body);
    if (!body.success) {
      return refuse(reply, 400, "invalid_contract", "Invalid contract.", {
        issues: issuesOf(body.error),
      });
    }
    const { address: at, name, abi } = body.data;
    if (engine.isRegistered(at)) {
      return refuse(
        reply,
        409,
        "already_registered",
        "This contract is already registered.",
      );
    }
    if (abi) {
      const pasted = { address: at, name, abi, implementation: null };
      return reply
        .code(201)
        .send(engine.register({ ...pasted, source: "pasted" }));
    }
    try {
      const found = await lookup.get(at);
      return reply.code(201).send(
        engine.register({
          address: at,
          name,
          abi: found.abi,
          source: "verified",
          implementation: found.implementation,
        }),
      );
    } catch (error) {
      return lookupFailed(reply, request.log, error);
    }
  });

  app.post<ByAddress>(
    "/contracts/:address/disable",
    (request, reply) =>
      engine.disable(request.params.address) ?? notFound(reply),
  );

  app.post<ByAddress>(
    "/contracts/:address/enable",
    (request, reply) =>
      engine.enable(request.params.address) ?? notFound(reply),
  );

  done();
};
