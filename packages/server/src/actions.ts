import type { ManualActionItem } from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { encodeFunctionData, parseAbiItem, type AbiFunction } from "viem";
import { z } from "zod";
import type {
  ActionRow,
  EngineCommands,
  EngineReads,
  ManualActionKind,
} from "./engine/types";
import { refuse } from "./refuse";

// Pausing and unpausing by hand during an incident (`RESPONSES.md`): a
// person's decision, sent by the engine from the signing key through the
// same path as a response, in any mode: a call to one of the contract's
// own functions, or the controller's pauses for a contract registered
// with it.

const note = z.string().trim().max(500).optional();
const action = z.union([
  z.object({
    controller: z.enum(["pause", "unpause"]),
    scope: z.enum(["contract", "function"]),
    selector: z
      .string()
      .regex(/^0x[0-9a-fA-F]{8}$/, "must be a 4-byte selector")
      .optional(),
    note,
  }),
  z.object({
    call: z.object({
      function: z.string().min(3).max(500),
      args: z.array(z.string().max(1000)).max(20),
    }),
    note,
  }),
]);

type ByAddress = { Params: { address: string } };

function toItem(row: ActionRow): ManualActionItem {
  const tx = (row.tx ?? {}) as { hash?: unknown };
  return {
    id: row.id,
    kind: row.kind,
    target: row.target,
    selector: row.selector,
    function: row.function,
    args: row.args,
    note: row.note,
    status: row.status,
    error: row.error,
    txHash: typeof tx.hash === "string" ? tx.hash : null,
    createdAt: row.created_at,
  };
}

/** An argument as the ABI encoder takes it, from the text a person typed. */
function argument(type: string, text: string): unknown {
  if (/^u?int\d*$/.test(type)) return BigInt(text);
  if (type === "bool") {
    if (text !== "true" && text !== "false") throw new Error("true or false");
    return text === "true";
  }
  if (type === "address" || /^bytes\d*$/.test(type) || type === "string") {
    return text;
  }
  throw new Error(`${type} arguments are not supported here`);
}

/** Throws unless the call encodes: its arguments fit its signature. */
function encodes(call: { function: string; args: string[] }) {
  const item = parseAbiItem(`function ${call.function}`) as AbiFunction;
  if (item.inputs.length !== call.args.length) {
    throw new Error(
      `${call.function} takes ${item.inputs.length} arguments, not ${call.args.length}`,
    );
  }
  encodeFunctionData({
    abi: [item],
    args: item.inputs.map((input, i) => argument(input.type, call.args[i]!)),
  });
}

export const actionRoutes: FastifyPluginCallback<{
  commands: EngineCommands;
  reads: EngineReads;
}> = (app, { commands, reads }, done) => {
  app.post<ByAddress>("/contracts/:address/actions", async (request, reply) => {
    const contract = await reads.contract(request.params.address);
    if (!contract) {
      return refuse(
        reply,
        404,
        "not_found",
        "No contract is registered at this address.",
      );
    }
    const body = action.safeParse(request.body ?? {});
    if (!body.success) {
      return refuse(reply, 400, "invalid_action", "Invalid action.");
    }
    const by = request.account?.username ?? "someone";
    const said = body.data.note ? `${by}: ${body.data.note}` : by;

    if ("call" in body.data) {
      const { call } = body.data;
      try {
        encodes(call);
      } catch (error) {
        return refuse(
          reply,
          400,
          "invalid_action",
          error instanceof Error ? error.message : String(error),
        );
      }
      // The engine's refusal, a failed pre-flight or no usable key,
      // passes through with its message.
      const row = await commands.createAction({
        action: "call",
        target: contract.address,
        function: call.function,
        args: call.args,
        note: said,
      });
      request.log.info(
        {
          action: row.id,
          kind: "call",
          function: call.function,
          contract: contract.address,
          by,
        },
        "manual action",
      );
      return reply.code(201).send(toItem(row));
    }

    const { controller, scope, selector } = body.data;
    if (scope === "function" && !selector) {
      return refuse(
        reply,
        400,
        "invalid_action",
        "Pausing one function needs its selector.",
      );
    }
    const registered = (await reads.registrations()).some(
      (r) =>
        r.contract_address.toLowerCase() === contract.address.toLowerCase(),
    );
    if (!registered) {
      return refuse(
        reply,
        409,
        "not_on_controller",
        "This contract is not registered with the controller.",
      );
    }
    const kind: ManualActionKind = `${controller === "pause" ? "trip" : "reset"}_${
      scope === "contract" ? "global" : "function"
    }`;
    const row = await commands.createAction({
      action: kind,
      target: contract.address,
      ...(scope === "function" ? { selector: selector!.toLowerCase() } : {}),
      note: said,
    });
    request.log.info(
      { action: row.id, kind, contract: contract.address, by },
      "manual action",
    );
    return reply.code(201).send(toItem(row));
  });

  done();
};
