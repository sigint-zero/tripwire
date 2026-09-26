import { issuesOf, rule, type RuleCheck } from "@tripwire/shared";
import type { FastifyPluginCallback, FastifyReply } from "fastify";
import { z } from "zod";
import { abiRoutes } from "./abi";
import { MockEngine } from "./mock-engine";

const submission = z.object({
  rule: z.unknown(),
  checkOnly: z.boolean().optional(),
});

const reasons: Record<number, string> = { 400: "Bad Request", 409: "Conflict" };

function refuse(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  extra: object = {},
) {
  return reply.code(status).send({
    statusCode: status,
    error: reasons[status],
    code,
    message,
    ...extra,
  });
}

export const api: FastifyPluginCallback = (app, _options, done) => {
  const engine = new MockEngine();

  app.get("/health", () => ({ status: "ok" }));
  app.get("/engine", () => engine.info);
  app.register(abiRoutes, { chainId: engine.info.chainId });

  app.get("/rules", () => engine.list());

  // One way in for every rule: checked only, or checked and stored.
  app.post("/rules", (request, reply) => {
    const body = submission.safeParse(request.body);
    if (!body.success) {
      return refuse(
        reply,
        400,
        "invalid_request",
        "Expected { rule, checkOnly }.",
      );
    }
    const parsed = rule.safeParse(body.data.rule);
    if (!parsed.success) {
      const issues = issuesOf(parsed.error);
      if (body.data.checkOnly) {
        const verdict: RuleCheck = {
          valid: false,
          issues,
          sentence: null,
          evaluation: null,
          warmupSeconds: 0,
          duplicateOf: null,
          simulated: true,
        };
        return verdict;
      }
      return refuse(reply, 400, "invalid_rule", "Invalid rule.", { issues });
    }

    const check = engine.check(parsed.data);
    if (body.data.checkOnly) return check;
    if (check.duplicateOf) {
      return refuse(
        reply,
        409,
        "duplicate",
        "An identical rule already watches this contract.",
        { duplicateOf: check.duplicateOf },
      );
    }
    if (engine.nameTaken(parsed.data)) {
      return refuse(
        reply,
        409,
        "name_taken",
        "Another rule on this contract has that name.",
      );
    }
    const saved = engine.create(parsed.data);
    return reply.code(201).send({ ...check, id: saved.id, stored: true });
  });

  done();
};
