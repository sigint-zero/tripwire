import { invariantDraft, rule } from "@tripwire/shared";
import type { FastifyPluginCallback, FastifyReply } from "fastify";
import type { ZodError } from "zod";
import { abiRoutes } from "./abi";
import { MockEngine, preview } from "./mock-engine";

function invalid(reply: FastifyReply, error: ZodError) {
  return reply.code(400).send({
    statusCode: 400,
    error: "Bad Request",
    code: "invalid_rule",
    message: "Invalid invariant.",
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

export const api: FastifyPluginCallback = (app, _options, done) => {
  const engine = new MockEngine();

  app.get("/health", () => ({ status: "ok" }));
  app.register(abiRoutes);

  app.get("/invariants", () => engine.list());

  app.post("/invariants", (request, reply) => {
    const draft = invariantDraft.safeParse(request.body);
    if (!draft.success) return invalid(reply, draft.error);
    return reply.code(201).send(engine.create(draft.data));
  });

  app.post("/invariants/preview", (request, reply) => {
    const parsed = rule.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    return preview(parsed.data);
  });

  done();
};
