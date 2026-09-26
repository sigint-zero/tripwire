import { issuesOf, type Violation } from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { EngineReads, ViolationRow } from "./engine/types";
import { refuse } from "./refuse";
import { DASHBOARD, type AppStore } from "./store";

const id = z.string().regex(/^\d+$/, "must be an id");
const query = z.object({
  rule: id.optional(),
  contract: z.string().optional(),
  open: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  before: id.optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
const note = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((n) => n || null);
const acknowledgement = z.object({ note });
const many = z.object({
  ids: z.array(id).min(1).max(1000),
  note,
});

function toViolation(row: ViolationRow): Violation {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    severity: row.severity,
    contractAddress: row.contract_address,
    kind: row.kind,
    blockNumber: row.block_number,
    blockTime: row.block_time,
    txHash: row.tx_hash,
    evidence: row.evidence,
    createdAt: row.created_at,
    acknowledged:
      row.acknowledged_by && row.acknowledged_at
        ? {
            by: row.acknowledged_by,
            note: row.note,
            at: row.acknowledged_at,
          }
        : null,
  };
}

type ById = { Params: { id: string } };

// The engine records every violation; the application only remembers
// which ones a person has seen to.
export const violationRoutes: FastifyPluginCallback<{
  reads: EngineReads;
  store: AppStore;
}> = (app, { reads, store }, done) => {
  const notFound = (reply: Parameters<typeof refuse>[0]) =>
    refuse(reply, 404, "not_found", "No such violation.");

  app.get("/violations", async (request, reply) => {
    const params = query.safeParse(request.query);
    if (!params.success) {
      return refuse(reply, 400, "invalid_request", "Invalid query.", {
        issues: issuesOf(params.error),
      });
    }
    const { rule, contract, open, before, limit } = params.data;
    let contractId: string | undefined;
    if (contract) {
      const row = await reads.contract(contract);
      if (!row) return [];
      contractId = row.id;
    }
    const rows = await reads.violations({
      ruleId: rule,
      contractId,
      open,
      before,
      limit,
    });
    return rows.map(toViolation);
  });

  app.get<ById>("/violations/:id", async (request, reply) => {
    const row = await reads.violation(request.params.id);
    return row ? toViolation(row) : notFound(reply);
  });

  // Acknowledging twice keeps the first acknowledgement.
  app.post<ById>("/violations/:id/acknowledge", async (request, reply) => {
    const body = acknowledgement.safeParse(request.body ?? {});
    if (!body.success) {
      return refuse(reply, 400, "invalid_request", "Invalid acknowledgement.", {
        issues: issuesOf(body.error),
      });
    }
    const row = await reads.violation(request.params.id);
    if (!row) return notFound(reply);
    await store.acknowledge(
      [row.id],
      request.account?.id ?? DASHBOARD,
      body.data.note,
    );
    const updated = await reads.violation(row.id);
    return updated ? toViolation(updated) : notFound(reply);
  });

  // A run of violations at once: all of them, or none when one is missing.
  app.post("/violations/acknowledge", async (request, reply) => {
    const body = many.safeParse(request.body);
    if (!body.success) {
      return refuse(reply, 400, "invalid_request", "Expected { ids, note }.", {
        issues: issuesOf(body.error),
      });
    }
    const ids = [...new Set(body.data.ids)];
    const found = new Set(
      (await reads.violations({ ids, limit: ids.length })).map((v) => v.id),
    );
    const missing = ids.find((i) => !found.has(i));
    if (missing) {
      return refuse(reply, 404, "not_found", `No violation ${missing}.`);
    }
    await store.acknowledge(
      ids,
      request.account?.id ?? DASHBOARD,
      body.data.note,
    );
    const updated = await reads.violations({ ids, limit: ids.length });
    return updated.map(toViolation);
  });

  done();
};
