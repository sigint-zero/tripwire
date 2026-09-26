import {
  issuesOf,
  rule,
  shortSignature,
  type Rule,
  type RuleCheck,
  type SavedRule,
} from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
  EngineError,
  type DryRun,
  type EngineCommands,
  type EngineReads,
  type Evidence,
  type RuleRow,
} from "./engine/types";
import { refuse } from "./refuse";
import type { AppStore } from "./store";

const submission = z.object({
  rule: z.unknown(),
  checkOnly: z.boolean().optional(),
});

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

function toSaved(row: RuleRow, submitters: Map<string, string>): SavedRule {
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
    createdAt: row.created_at,
  };
}

export const ruleRoutes: FastifyPluginCallback<{
  commands: EngineCommands;
  reads: EngineReads;
  store: AppStore;
  simulated: boolean;
}> = (app, { commands, reads, store, simulated }, done) => {
  app.get<{ Querystring: { contract?: string } }>("/rules", async (request) => {
    let rows: RuleRow[];
    if (request.query.contract) {
      const contract = await reads.contract(request.query.contract);
      rows = contract ? await reads.rules({ contractId: contract.id }) : [];
    } else {
      rows = await reads.rules();
    }
    const submitters = await store.submitters(
      rows.filter((r) => r.origin === "mcp").map((r) => r.id),
    );
    return rows.map((row) => toSaved(row, submitters));
  });

  // One way in for every rule: checked only, or checked and stored.
  app.post("/rules", async (request, reply) => {
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

    const parsed = rule.safeParse(body.data.rule);
    if (!parsed.success) return invalid(issuesOf(parsed.error));
    const document = parsed.data;

    const contract = await reads.contract(document.contract);
    if (!contract) {
      return refuse(
        reply,
        400,
        "contract_not_registered",
        "This contract is not registered. Add it in Contracts first.",
      );
    }

    let dry: DryRun;
    try {
      dry = await commands.dryRun(document);
    } catch (error) {
      if (error instanceof EngineError && error.issues) {
        return invalid(error.issues);
      }
      throw error;
    }
    const [health, existing] = await Promise.all([
      commands.health(),
      reads.rules({ contractId: contract.id }),
    ]);
    const key = watchKey(dry.document);
    const duplicate = existing.find((r) => watchKey(r.document) === key);
    const check = toCheck(
      dry,
      health.head ?? 0,
      duplicate?.id ?? null,
      simulated,
    );
    if (body.data.checkOnly) return check;

    if (duplicate) {
      return refuse(
        reply,
        409,
        "duplicate",
        "An identical rule already watches this contract.",
        { duplicateOf: duplicate.id },
      );
    }
    if (existing.some((r) => r.name === document.name)) {
      return refuse(
        reply,
        409,
        "name_taken",
        "Another rule on this contract has that name.",
      );
    }
    // A rule added to a disabled contract starts disabled, so it stays quiet.
    const enabled = !(await store.disable(contract.id));
    const created = await commands.createRule({
      document: dry.document,
      enabled,
      origin: "app",
    });
    return reply
      .code(201)
      .send({ ...check, id: created.id, stored: true, enabled });
  });

  done();
};
