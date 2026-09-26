import {
  issuesOf,
  type CheckNow,
  type CurrentValue,
  type RuleStatus,
  type StoredRuleCheck,
} from "@tripwire/shared";
import type { FastifyPluginCallback, FastifyReply } from "fastify";
import { z } from "zod";
import type { EngineCommands, EngineReads } from "./engine/types";
import { refuse } from "./refuse";
import type { Checked, RuleService } from "./rule-service";
import { seriesOfRule } from "./rule-series";
import type { AppStore } from "./store";

const submission = z.object({
  rule: z.unknown(),
  checkOnly: z.boolean().optional(),
});
const change = z.strictObject({
  enabled: z.boolean().optional(),
  display: z
    .strictObject({
      decimals: z.number().int().min(0).max(77).nullable(),
      unit: z
        .string()
        .trim()
        .max(16)
        .nullable()
        .transform((u) => u || null),
    })
    .optional(),
});
const pins = z.object({
  ruleIds: z.array(z.string().regex(/^\d+$/)).max(12),
});

type ById = { Params: { id: string } };

const STATUSES: RuleStatus[] = [
  "off",
  "tripped",
  "error",
  "warming",
  "holding",
];

export const ruleRoutes: FastifyPluginCallback<{
  commands: EngineCommands;
  reads: EngineReads;
  store: AppStore;
  rules: RuleService;
}> = (app, { commands, reads, store, rules }, done) => {
  const notFound = (reply: FastifyReply) =>
    refuse(reply, 404, "not_found", "No such rule.");

  /** Refusals shared by storing a new rule and replacing one. */
  const conflict = (reply: FastifyReply, verdict: Checked) => {
    if (verdict.duplicate) {
      return refuse(
        reply,
        409,
        "duplicate",
        "An identical rule already watches this contract.",
        { duplicateOf: verdict.duplicate.id },
      );
    }
    if (verdict.nameTaken) {
      return refuse(
        reply,
        409,
        "name_taken",
        "Another rule on this contract has that name.",
      );
    }
    return null;
  };

  app.get<{ Querystring: { contract?: string; status?: string } }>(
    "/rules",
    async (request, reply) => {
      const { contract: address, status } = request.query;
      if (status !== undefined && !STATUSES.includes(status as RuleStatus)) {
        return refuse(
          reply,
          400,
          "invalid_request",
          `status must be one of ${STATUSES.join(", ")}.`,
        );
      }
      let rows;
      if (address) {
        const contract = await reads.contract(address);
        if (!contract) return [];
        rows = await reads.rules({ contractId: contract.id });
      } else {
        rows = await reads.rules();
      }
      const saved = await rules.saved(rows);
      return status ? saved.filter((r) => r.status === status) : saved;
    },
  );

  app.get<ById>("/rules/:id/series", async (request, reply) => {
    const row = await reads.rule(request.params.id);
    return row ? seriesOfRule(reads, row.id) : notFound(reply);
  });

  app.get<ById>(
    "/rules/:id/current",
    async (request, reply): Promise<CurrentValue[] | undefined> => {
      const row = await reads.rule(request.params.id);
      if (!row) return notFound(reply);
      const series = await seriesOfRule(reads, row.id);
      const points = await reads.newestPoints(series.map((s) => s.id));
      return series.flatMap((s) => {
        const p = points.find((point) => point.series_id === s.id);
        return p
          ? [
              {
                seriesId: s.id,
                value: p.value,
                blockNumber: p.block_number,
                blockTime: p.block_time,
              },
            ]
          : [];
      });
    },
  );

  // The engine's own judgement at the current block, recording nothing:
  // no value, violation, notification or response. It works on a rule
  // that is off, which is how a person checks one before arming it.
  app.post<ById>(
    "/rules/:id/check",
    async (request, reply): Promise<CheckNow | undefined> => {
      const row = await reads.rule(request.params.id);
      if (!row) return notFound(reply);
      const [dry, health] = await Promise.all([
        commands.dryRun(row.document),
        commands.health(),
      ]);
      const warmup = dry.needs.warmup_seconds;
      const left = dry.evaluation.warming
        ? Math.max(
            0,
            Math.ceil(
              (Date.parse(row.created_at) + warmup * 1000 - Date.now()) / 1000,
            ),
          )
        : 0;
      return {
        block: health.head,
        wouldTripNow: dry.evaluation.would_trip,
        warming: dry.evaluation.warming,
        warmupSecondsLeft: left,
        evidence: dry.evaluation.evidence,
      };
    },
  );

  app.get<ById>("/rules/:id", async (request, reply) => {
    const row = await reads.rule(request.params.id);
    return row ? (await rules.saved([row]))[0] : notFound(reply);
  });

  // One way in for every rule: checked only, or checked and stored. A
  // replacement comes the same way, to the rule it replaces.
  const submit = async (
    request: { body: unknown; params: { id?: string } },
    reply: FastifyReply,
  ) => {
    const body = submission.safeParse(request.body);
    if (!body.success) {
      return refuse(
        reply,
        400,
        "invalid_request",
        "Expected { rule, checkOnly }.",
      );
    }
    const replacing = request.params.id;
    const current = replacing ? await reads.rule(replacing) : null;
    if (replacing && !current) return notFound(reply);

    const verdict = await rules.check(body.data.rule, current ?? undefined);
    switch (verdict.status) {
      case "invalid":
        return body.data.checkOnly
          ? rules.invalid(verdict.issues)
          : refuse(reply, 400, "invalid_rule", "Invalid rule.", {
              issues: verdict.issues,
            });
      case "contract_changed":
        return refuse(
          reply,
          400,
          "contract_changed",
          "A rule stays on its contract. Create a new rule for another one.",
        );
      case "not_registered":
        return refuse(
          reply,
          400,
          "contract_not_registered",
          "This contract is not registered. Add it in Contracts first.",
        );
    }
    if (body.data.checkOnly) return verdict.check;
    const refused = conflict(reply, verdict);
    if (refused) return refused;

    if (current) {
      await commands.replaceRule(current.id, verdict.document);
      const stored: StoredRuleCheck = {
        ...verdict.check,
        id: current.id,
        stored: true,
        enabled: current.enabled,
      };
      return stored;
    }
    // A rule added to a disabled contract starts disabled, so it stays quiet.
    const enabled = !(await store.disable(verdict.contract.id));
    const stored: StoredRuleCheck = {
      ...verdict.check,
      id: await rules.create(verdict, "app", enabled),
      stored: true,
      enabled,
    };
    return reply.code(201).send(stored);
  };
  app.post("/rules", (request, reply) =>
    submit({ body: request.body, params: {} }, reply),
  );
  app.put<ById>("/rules/:id", (request, reply) => submit(request, reply));

  // Switching a rule, and how its values are shown.
  app.patch<ById>("/rules/:id", async (request, reply) => {
    const body = change.safeParse(request.body);
    if (!body.success) {
      return refuse(reply, 400, "invalid_request", "Invalid change.", {
        issues: issuesOf(body.error),
      });
    }
    const row = await reads.rule(request.params.id);
    if (!row) return notFound(reply);
    const { enabled, display } = body.data;
    if (enabled !== undefined) {
      const disabled = await store.disable(row.contract_id);
      if (enabled && disabled) {
        return refuse(
          reply,
          409,
          "contract_disabled",
          "This rule's contract is disabled. Enable the contract first.",
        );
      }
      if (enabled !== row.enabled) {
        await commands.setRuleEnabled(row.id, enabled);
      }
      // Switched off by hand, it stays off when the contract is enabled.
      if (!enabled && disabled) await store.keepOff(row.contract_id, row.id);
    }
    if (display) await store.setDisplay(row.id, display);
    const updated = await reads.rule(row.id);
    return updated ? (await rules.saved([updated]))[0] : notFound(reply);
  });

  // The engine deletes the rule with its history; what the application
  // kept about it goes after, or is swept later.
  app.delete<ById>("/rules/:id", async (request, reply) => {
    const row = await reads.rule(request.params.id);
    if (!row) return notFound(reply);
    await commands.deleteRule(row.id);
    await store
      .forgetRules([row.id])
      .catch((error: unknown) => request.log.warn(error));
    return reply.code(204).send();
  });

  // The rules charted on the Overview, in order; deleted ones drop out.
  app.get("/pinned-rules", async () => {
    const [pinned, rules] = await Promise.all([store.pinned(), reads.rules()]);
    const present = new Set(rules.map((r) => r.id));
    return pinned.filter((id) => present.has(id));
  });

  app.put("/pinned-rules", async (request, reply) => {
    const body = pins.safeParse(request.body);
    if (!body.success) {
      return refuse(reply, 400, "invalid_request", "Expected { ruleIds }.", {
        issues: issuesOf(body.error),
      });
    }
    const ids = [...new Set(body.data.ruleIds)];
    const present = new Set((await reads.rules()).map((r) => r.id));
    const unknown = ids.find((id) => !present.has(id));
    if (unknown) {
      return refuse(reply, 400, "unknown_rule", `No rule ${unknown}.`);
    }
    await store.setPinned(ids);
    return ids;
  });

  done();
};
