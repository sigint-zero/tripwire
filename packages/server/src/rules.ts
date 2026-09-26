import { issuesOf, rule, type RuleCheck } from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { MockEngine } from "./mock-engine";
import { refuse } from "./refuse";

const submission = z.object({
  rule: z.unknown(),
  checkOnly: z.boolean().optional(),
});

export const ruleRoutes: FastifyPluginCallback<{ engine: MockEngine }> = (
  app,
  { engine },
  done,
) => {
  app.get<{ Querystring: { contract?: string } }>("/rules", (request) =>
    engine.rules(request.query.contract),
  );

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

    if (!engine.isRegistered(parsed.data.contract)) {
      return refuse(
        reply,
        400,
        "contract_not_registered",
        "This contract is not registered. Add it in Contracts first.",
      );
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
    return reply
      .code(201)
      .send({ ...check, id: saved.id, stored: true, enabled: saved.enabled });
  });

  done();
};
