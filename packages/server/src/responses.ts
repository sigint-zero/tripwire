import {
  issuesOf,
  type ResponseItem,
  type ResponseStatus,
  type ResponseTab,
  type ResponseTx,
} from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { formatGwei } from "viem";
import { z } from "zod";
import {
  EngineError,
  type EngineCommands,
  type EngineReads,
  type ResponseRow,
} from "./engine/types";
import { refuse } from "./refuse";

// The approval queue: responses are the engine's, read from its view;
// approving and rejecting pass a person's decision to the engine, which
// re-checks, rebuilds and sends. The application never signs anything.

const TABS: Record<ResponseTab, ResponseStatus[]> = {
  waiting: ["awaiting_approval"],
  in_flight: ["pending", "approved", "submitted"],
  history: ["confirmed", "failed", "abandoned"],
};

const id = z.string().regex(/^\d+$/, "must be an id");
const query = z.object({
  status: z.enum(["waiting", "in_flight", "history"]).optional(),
  contract: z.string().optional(),
  before: id.optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
const rejection = z.object({
  reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((r) => r || null),
});

type Raw = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
const num = (v: unknown) =>
  typeof v === "number"
    ? v
    : typeof v === "string" && v !== ""
      ? Number(v)
      : null;
/** Wei as gwei, for fees. */
const gwei = (v: unknown) => {
  const wei = str(v);
  return wei && /^\d+$/.test(wei) ? formatGwei(BigInt(wei)) : null;
};

/** The built transaction, from the engine's `responses.tx`. */
export function toTx(value: unknown): ResponseTx | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Raw;
  const attempts = Array.isArray(raw.attempts) ? (raw.attempts as Raw[]) : [];
  const gasLimit = str(raw.gas_limit);
  const maxFee = str(raw.max_fee_per_gas);
  return {
    to: str(raw.target),
    // The engine does not name the signing key in the transaction.
    from: str(raw.from),
    function: str(raw.function),
    args: Array.isArray(raw.decoded_args)
      ? raw.decoded_args.map((a) => String(a))
      : [],
    value: str(raw.value) ?? "0",
    nonce: num(raw.nonce),
    gasLimit,
    maxFeeGwei: gwei(maxFee),
    maxPriorityFeeGwei: gwei(raw.max_priority_fee_per_gas),
    maxCostWei:
      gasLimit && maxFee && /^\d+$/.test(gasLimit) && /^\d+$/.test(maxFee)
        ? String(BigInt(gasLimit) * BigInt(maxFee))
        : null,
    hash: str(raw.hash),
    rebuilt: raw.approval_rebuilt === true,
    attempts: attempts.map((a) => ({
      hash: str(a.hash) ?? "",
      maxFeeGwei: gwei(a.max_fee_per_gas),
      maxPriorityFeeGwei: gwei(a.max_priority_fee_per_gas),
      block: num(a.submitted_block),
    })),
    block: num(raw.confirmed_block),
    gasUsed: str(raw.gas_used),
  };
}

function toResponse(row: ResponseRow): ResponseItem {
  return {
    id: row.id,
    status: row.status,
    action: row.action as ResponseItem["action"],
    mode: row.mode as ResponseItem["mode"],
    rule: { id: row.rule_id, name: row.rule_name },
    contract: { address: row.contract_address, name: row.contract_name },
    violation:
      row.violation_kind && row.violation_block !== null
        ? {
            id: row.violation_id,
            kind: row.violation_kind,
            blockNumber: row.violation_block,
          }
        : null,
    tx: toTx(row.tx),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type ById = { Params: { id: string } };

export const responseRoutes: FastifyPluginCallback<{
  commands: EngineCommands;
  reads: EngineReads;
}> = (app, { commands, reads }, done) => {
  const notFound = (reply: Parameters<typeof refuse>[0]) =>
    refuse(reply, 404, "not_found", "No such response.");

  app.get("/responses", async (request, reply) => {
    const params = query.safeParse(request.query);
    if (!params.success) {
      return refuse(reply, 400, "invalid_request", "Invalid query.", {
        issues: issuesOf(params.error),
      });
    }
    const { status, contract, before, limit } = params.data;
    const rows = await reads.responses({
      statuses: status ? TABS[status] : undefined,
      contractAddress: contract,
      before,
      limit,
    });
    return rows.map(toResponse);
  });

  app.get("/responses/counts", () => reads.responseCounts());

  app.get<ById>("/responses/:id", async (request, reply) => {
    const row = await reads.response(request.params.id);
    return row ? toResponse(row) : notFound(reply);
  });

  /** A decision someone else made first is told as what happened. */
  const decide = async (
    id: string,
    reply: Parameters<typeof refuse>[0],
    act: () => Promise<void>,
  ) => {
    if (!(await reads.response(id))) return notFound(reply);
    try {
      await act();
    } catch (error) {
      if (error instanceof EngineError && error.status === 409) {
        const now = await reads.response(id);
        return refuse(
          reply,
          409,
          "not_waiting",
          now
            ? `This response is no longer waiting: it is ${now.status.replace(/_/g, " ")}.`
            : "This response is no longer waiting.",
        );
      }
      throw error;
    }
    const row = await reads.response(id);
    return row ? toResponse(row) : notFound(reply);
  };

  app.post<ById>("/responses/:id/approve", async (request, reply) => {
    const { id } = request.params;
    return decide(id, reply, async () => {
      await commands.approveResponse(id);
      request.log.info(
        { response: id, by: request.account?.username },
        "response approved",
      );
    });
  });

  app.post<ById>("/responses/:id/reject", async (request, reply) => {
    const body = rejection.safeParse(request.body ?? {});
    if (!body.success) {
      return refuse(reply, 400, "invalid_request", "Invalid rejection.", {
        issues: issuesOf(body.error),
      });
    }
    const { id } = request.params;
    return decide(id, reply, async () => {
      await commands.rejectResponse(id, body.data.reason);
      request.log.info(
        { response: id, by: request.account?.username },
        "response rejected",
      );
    });
  });

  done();
};
