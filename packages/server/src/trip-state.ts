import type { TripStateItem } from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { toFunctionSelector } from "viem";
import type { EngineReads, TripStateRow } from "./engine/types";
import { toTx } from "./responses";

// What is paused now (`ACTIVITY.md`): the tripped rows of the engine's
// trip state for registered contracts, each with the function it names,
// who paused it when that was Tripwire, and for a confirmed call the
// rules whose confirmation reads true.

interface AbiFunction {
  type?: string;
  name?: string;
  inputs?: { type: string }[];
}

/** The contract's functions by selector, as positional signatures. */
function functionsOf(abi: unknown[] | null): Map<string, string> {
  const found = new Map<string, string>();
  for (const raw of abi ?? []) {
    const entry = raw as AbiFunction;
    if (entry.type !== "function" || !entry.name) continue;
    const signature = `${entry.name}(${(entry.inputs ?? []).map((p) => p.type).join(",")})`;
    try {
      found.set(toFunctionSelector(signature), signature);
    } catch {
      // A parameter viem cannot name has no selector here, and no name.
    }
  }
  return found;
}

export const tripStateRoutes: FastifyPluginCallback<{ reads: EngineReads }> = (
  app,
  { reads },
  done,
) => {
  app.get("/trip-state", async (): Promise<TripStateItem[]> => {
    const rows = await reads.tripState();
    if (rows.length === 0) return [];
    const [rules, responses] = await Promise.all([
      rows.some((r) => r.source === "verify") ? reads.rules() : [],
      rows.some((r) => r.tx_hash)
        ? reads.responses({ statuses: ["confirmed"], limit: 500 })
        : [],
    ]);
    // Tripwire's own responses, by every hash they were sent under.
    const byHash = new Map<string, (typeof responses)[number]>();
    for (const response of responses) {
      const tx = toTx(response.tx);
      for (const hash of [
        tx?.hash,
        ...(tx?.attempts ?? []).map((a) => a.hash),
      ]) {
        if (hash) byHash.set(hash.toLowerCase(), response);
      }
    }
    const confirming = (row: TripStateRow) =>
      rules
        .filter((rule) => {
          const onTrip = rule.document.on_trip;
          return (
            rule.enabled &&
            rule.contract_address.toLowerCase() ===
              row.contract_address.toLowerCase() &&
            onTrip.action === "call" &&
            onTrip.call.verify !== undefined &&
            toFunctionSelector(onTrip.call.function) === row.selector
          );
        })
        .map((rule) => ({ id: rule.id, name: rule.name }));

    return rows.map((row) => {
      const response = row.tx_hash
        ? byHash.get(row.tx_hash.toLowerCase())
        : undefined;
      const global = row.selector === "";
      return {
        contract: { address: row.contract_address, name: row.contract_name },
        scope: global ? "global" : "function",
        selector: global ? null : row.selector,
        function: global
          ? null
          : (functionsOf(row.abi).get(row.selector) ?? null),
        source: row.source,
        sinceBlock: row.since_block,
        sinceTime: null,
        txHash: row.tx_hash,
        actor: response
          ? {
              address: toTx(response.tx)?.from ?? null,
              is: "tripwire_response",
              responseId: response.id,
              rule: { id: response.rule_id, name: response.rule_name },
            }
          : null,
        rules: row.source === "verify" ? confirming(row) : [],
      };
    });
  });
  done();
};
