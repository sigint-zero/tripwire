import {
  address,
  issuesOf,
  type Contract,
  type ContractDetail,
} from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { lookupFailed, type AbiLookup } from "./abi";
import type { EngineCommands, EngineReads, ContractRow } from "./engine/types";
import { refuse } from "./refuse";
import { DASHBOARD, type AppStore } from "./store";

const name = z.string().trim().min(1, "is required").max(80);
const registration = z.object({
  address,
  name,
  abi: z.array(z.unknown()).optional(),
});
const change = z.object({ name });

type ByAddress = { Params: { address: string } };

/**
 * The engine's contract row, with what the application keeps about it:
 * whether a person disabled it, and whether its ABI came from a verified
 * source.
 */
function toContract(
  row: ContractRow,
  disables: Map<string, string[]>,
  sources: Awaited<ReturnType<AppStore["sources"]>>,
): Contract {
  const source = sources.get(row.address);
  return {
    id: row.id,
    address: row.address,
    name: row.name,
    active: !disables.has(row.id),
    ruleCount: row.rule_count,
    enabledCount: row.enabled_count,
    source: source?.verified ? "verified" : "pasted",
    implementation: source?.implementation
      ? { address: source.implementation, name: null }
      : null,
    createdAt: row.created_at,
  };
}

// Registering is where a person decides what Tripwire watches. Disabling a
// contract switches its rules off together; enabling it restores them.
export const contractRoutes: FastifyPluginCallback<{
  commands: EngineCommands;
  reads: EngineReads;
  store: AppStore;
  lookup: AbiLookup;
}> = (app, { commands, reads, store, lookup }, done) => {
  const notFound = (reply: Parameters<typeof refuse>[0]) =>
    refuse(
      reply,
      404,
      "not_found",
      "No contract is registered at this address.",
    );

  const detail = async (row: ContractRow): Promise<ContractDetail> => {
    const [disables, sources] = await Promise.all([
      store.disables(),
      store.sources(),
    ]);
    return { ...toContract(row, disables, sources), abi: row.abi ?? [] };
  };

  app.get("/contracts", async () => {
    const [rows, disables, sources] = await Promise.all([
      reads.contracts(),
      store.disables(),
      store.sources(),
    ]);
    return rows.map((row) => toContract(row, disables, sources));
  });

  app.get<ByAddress>("/contracts/:address", async (request, reply) => {
    const row = await reads.contract(request.params.address);
    return row ? detail(row) : notFound(reply);
  });

  app.post("/contracts", async (request, reply) => {
    const body = registration.safeParse(request.body);
    if (!body.success) {
      return refuse(reply, 400, "invalid_contract", "Invalid contract.", {
        issues: issuesOf(body.error),
      });
    }
    const { address: at, name, abi } = body.data;
    if (await reads.contract(at)) {
      return refuse(
        reply,
        409,
        "already_registered",
        "This contract is already registered.",
      );
    }
    if (abi) {
      const row = await commands.registerContract({ address: at, name, abi });
      return reply.code(201).send(await detail(row));
    }

    let verified;
    try {
      verified = await lookup.get(at);
    } catch (error) {
      return lookupFailed(reply, request.log, error);
    }
    const row = await commands.registerContract({
      address: at,
      name,
      abi: verified.abi.abi,
    });
    // The source is the application's to keep; the ABI went to the engine.
    await store
      .saveSource({
        address: row.address,
        verified: true,
        compiler: verified.compiler,
        implementation: verified.abi.implementation?.address ?? null,
        files: verified.files,
        fetchedFrom: "sourcify",
      })
      .catch((error: unknown) => request.log.warn(error));
    return reply.code(201).send(await detail(row));
  });

  app.patch<ByAddress>("/contracts/:address", async (request, reply) => {
    const body = change.safeParse(request.body);
    if (!body.success) {
      return refuse(reply, 400, "invalid_contract", "Invalid contract.", {
        issues: issuesOf(body.error),
      });
    }
    if (!(await reads.contract(request.params.address))) {
      return notFound(reply);
    }
    await commands.updateContract(request.params.address, body.data);
    // The engine answers with the contract alone; the view adds its counts.
    const updated = await reads.contract(request.params.address);
    return updated ? detail(updated) : notFound(reply);
  });

  // The engine deletes the contract with its rules and their history; what
  // the application kept about them goes after, or is swept later.
  app.delete<ByAddress>("/contracts/:address", async (request, reply) => {
    const row = await reads.contract(request.params.address);
    if (!row) return notFound(reply);
    const rules = (await reads.rules({ contractId: row.id })).map((r) => r.id);
    await commands.deleteContract(row.address);
    await Promise.all([
      store.forgetContract(row.id, row.address),
      store.forgetRules(rules),
    ]).catch((error: unknown) => request.log.warn(error));
    return reply.code(204).send();
  });

  // One batch call to the engine switches the rules, then the record of
  // which ones is written, so enabling restores exactly those.
  app.post<ByAddress>("/contracts/:address/disable", async (request, reply) => {
    const row = await reads.contract(request.params.address);
    if (!row) return notFound(reply);
    if (!(await store.disable(row.id))) {
      const on = (await reads.rules({ contractId: row.id }))
        .filter((r) => r.enabled)
        .map((r) => r.id);
      await commands.setRulesEnabled(on, false);
      try {
        await store.recordDisable(row.id, on, request.account?.id ?? DASHBOARD);
      } catch (error) {
        // Without the record the rules could not be restored together.
        await commands.setRulesEnabled(on, true).catch(() => {});
        throw error;
      }
    }
    return detail((await reads.contract(row.address)) ?? row);
  });

  app.post<ByAddress>("/contracts/:address/enable", async (request, reply) => {
    const row = await reads.contract(request.params.address);
    if (!row) return notFound(reply);
    const recorded = await store.disable(row.id);
    if (recorded) {
      // Rules deleted since, or already switched back on by hand, are skipped.
      const off = new Set(
        (await reads.rules({ contractId: row.id }))
          .filter((r) => !r.enabled)
          .map((r) => r.id),
      );
      await commands.setRulesEnabled(
        recorded.filter((id) => off.has(id)),
        true,
      );
      await store.clearDisable(row.id);
    }
    return detail((await reads.contract(row.address)) ?? row);
  });

  done();
};
