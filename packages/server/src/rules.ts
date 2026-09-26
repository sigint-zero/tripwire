import {
  issuesOf,
  rule,
  shortSignature,
  type Rule,
  type RuleCheck,
  type SavedRule,
  type StoredRuleCheck,
} from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
  EngineError,
  type DryRun,
  type EngineCommands,
  type EngineReads,
  type Evidence,
  type ContractRow,
  type RuleRow,
} from "./engine/types";
import { refuse } from "./refuse";
import type { AppStore, Display } from "./store";

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

const NO_DISPLAY: Display = { decimals: null, unit: null };

/** A document in a form where equal rules compare equal: sorted keys, lowercase addresses. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return value.toLowerCase();
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

/** What makes two rules the same watch; name, description and severity do not. */
function watchKey(document: Rule): string {
  const { contract, when, trip_when, on_trip } = document;
  return JSON.stringify(canonical({ contract, when, trip_when, on_trip }));
}

/** Every contract read in the evidence, with the value the engine saw. */
function readsOf(evidence: unknown): { call: string; value: string }[] {
  const found = new Map<string, string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const e = node as Evidence & {
      function?: string;
      returns?: number;
      address?: string;
    };
    if (e.node === "view_call" && typeof e.value === "string" && e.function) {
      const short = shortSignature(e.function);
      const call = e.returns === undefined ? short : `${short}[${e.returns}]`;
      found.set(e.address ? `${call} of ${e.address}` : call, e.value);
    }
    Object.values(node).forEach(walk);
  };
  walk(evidence);
  return [...found].map(([call, value]) => ({ call, value }));
}

function toCheck(
  dry: DryRun,
  block: number,
  duplicateOf: string | null,
  simulated: boolean,
): RuleCheck {
  return {
    valid: true,
    issues: [],
    sentence: dry.description,
    evaluation: {
      block,
      wouldTripNow: dry.evaluation.would_trip,
      reads: readsOf(dry.evaluation.evidence),
    },
    warmupSeconds: dry.needs.warmup_seconds,
    duplicateOf,
    simulated,
  };
}

function toSaved(
  row: RuleRow,
  submitters: Map<string, string>,
  displays: Map<string, Display>,
): SavedRule {
  return {
    id: row.id,
    rule: row.document,
    sentence: row.description,
    enabled: row.enabled,
    origin:
      row.origin === "app"
        ? "dashboard"
        : row.origin === "mcp"
          ? { mcp: submitters.get(row.id) ?? "agent" }
          : "api",
    warming: row.warming,
    lastEvaluatedBlock: row.last_evaluated_block,
    display: displays.get(row.id) ?? NO_DISPLAY,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type ById = { Params: { id: string } };

export const ruleRoutes: FastifyPluginCallback<{
  commands: EngineCommands;
  reads: EngineReads;
  store: AppStore;
  simulated: boolean;
}> = (app, { commands, reads, store, simulated }, done) => {
  const notFound = (reply: Parameters<typeof refuse>[0]) =>
    refuse(reply, 404, "not_found", "No such rule.");

  const saved = async (rows: RuleRow[]) => {
    const [submitters, displays] = await Promise.all([
      store.submitters(rows.filter((r) => r.origin === "mcp").map((r) => r.id)),
      store.displays(rows.map((r) => r.id)),
    ]);
    return rows.map((row) => toSaved(row, submitters, displays));
  };

  /**
   * Checks a document for its contract as the engine would store it. When
   * `replacing` names a rule, that rule is not its own duplicate.
   */
  const check = async (
    document: Rule,
    contract: ContractRow,
    replacing?: string,
  ): Promise<
    | { check: RuleCheck; dry: DryRun; duplicate?: RuleRow; nameTaken: boolean }
    | { issues: RuleCheck["issues"] }
  > => {
    let dry: DryRun;
    try {
      dry = await commands.dryRun(document);
    } catch (error) {
      if (error instanceof EngineError && error.issues) {
        return { issues: error.issues };
      }
      throw error;
    }
    const [health, existing] = await Promise.all([
      commands.health(),
      reads.rules({ contractId: contract.id }),
    ]);
    const others = existing.filter((r) => r.id !== replacing);
    const key = watchKey(dry.document);
    const duplicate = others.find((r) => watchKey(r.document) === key);
    return {
      check: toCheck(dry, health.head ?? 0, duplicate?.id ?? null, simulated),
      dry,
      duplicate,
      nameTaken: others.some((r) => r.name === dry.document.name),
    };
  };

  /** Refusals shared by storing a new rule and replacing one. */
  const conflict = (
    reply: Parameters<typeof refuse>[0],
    verdict: { duplicate?: RuleRow; nameTaken: boolean },
  ) => {
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

  app.get<{ Querystring: { contract?: string } }>("/rules", async (request) => {
    if (!request.query.contract) return saved(await reads.rules());
    const contract = await reads.contract(request.query.contract);
    return contract
      ? saved(await reads.rules({ contractId: contract.id }))
      : [];
  });

  app.get<ById>("/rules/:id", async (request, reply) => {
    const row = await reads.rule(request.params.id);
    return row ? (await saved([row]))[0] : notFound(reply);
  });

  // One way in for every rule: checked only, or checked and stored. A
  // replacement comes the same way, to the rule it replaces.
  const submit = async (
    request: { body: unknown; params: { id?: string } },
    reply: Parameters<typeof refuse>[0],
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
    const invalid = (issues: RuleCheck["issues"]) => {
      if (!body.data.checkOnly) {
        return refuse(reply, 400, "invalid_rule", "Invalid rule.", { issues });
      }
      const verdict: RuleCheck = {
        valid: false,
        issues,
        sentence: null,
        evaluation: null,
        warmupSeconds: 0,
        duplicateOf: null,
        simulated,
      };
      return verdict;
    };

    const replacing = request.params.id;
    const current = replacing ? await reads.rule(replacing) : null;
    if (replacing && !current) return notFound(reply);

    const parsed = rule.safeParse(body.data.rule);
    if (!parsed.success) return invalid(issuesOf(parsed.error));
    const document = parsed.data;

    if (
      current &&
      document.contract.toLowerCase() !== current.contract_address
    ) {
      return refuse(
        reply,
        400,
        "contract_changed",
        "A rule stays on its contract. Create a new rule for another one.",
      );
    }
    const contract = await reads.contract(document.contract);
    if (!contract) {
      return refuse(
        reply,
        400,
        "contract_not_registered",
        "This contract is not registered. Add it in Contracts first.",
      );
    }

    const verdict = await check(document, contract, replacing);
    if ("issues" in verdict) return invalid(verdict.issues);
    if (body.data.checkOnly) return verdict.check;
    const refused = conflict(reply, verdict);
    if (refused) return refused;

    if (current) {
      await commands.replaceRule(current.id, verdict.dry.document);
      const stored: StoredRuleCheck = {
        ...verdict.check,
        id: current.id,
        stored: true,
        enabled: current.enabled,
      };
      return stored;
    }
    // A rule added to a disabled contract starts disabled, so it stays quiet.
    const enabled = !(await store.disable(contract.id));
    const created = await commands.createRule({
      document: verdict.dry.document,
      enabled,
      origin: "app",
    });
    const stored: StoredRuleCheck = {
      ...verdict.check,
      id: created.id,
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
    return updated ? (await saved([updated]))[0] : notFound(reply);
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
