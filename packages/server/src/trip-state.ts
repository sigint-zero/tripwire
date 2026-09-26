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
    const hashes = rows.flatMap((r) => (r.tx_hash ? [r.tx_hash] : []));
    const observed = rows.some((r) => r.source === "verify");
    const [rules, responses, actions, times] = await Promise.all([
      observed ? reads.rules() : [],
      hashes.length > 0
        ? reads.responses({ statuses: ["confirmed"], limit: 500 })
        : [],
      hashes.length > 0 || observed ? reads.actions() : [],
      reads.controllerTimes(hashes),
    ]);
    // A controller pause's time is its controller event's.
    const timeOf = new Map(times.map((t) => [t.tx_hash, t.block_time]));
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
    // And the pauses people asked for by hand.
    const byHand = new Map<string, (typeof actions)[number]>();
    for (const action of actions) {
      const tx = toTx(action.tx);
      for (const hash of [
        tx?.hash,
        ...(tx?.attempts ?? []).map((a) => a.hash),
      ]) {
        if (hash) byHand.set(hash.toLowerCase(), action);
      }
    }
    // A confirmed call observed in place carries no transaction: it was a
    // person's when their last call to that function on the contract
    // confirmed at or before the block it was first seen.
    const calledByHand = (row: TripStateRow) =>
      actions.find((action) => {
        if (action.kind !== "call" || action.status !== "confirmed") {
          return false;
        }
        if (
          action.target.toLowerCase() !== row.contract_address.toLowerCase()
        ) {
          return false;
        }
        const landed = toTx(action.tx)?.block;
        try {
          return (
            toFunctionSelector(action.function ?? "") === row.selector &&
            landed != null &&
            landed <= row.since_block
          );
        } catch {
          return false;
        }
      });
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
      const hash = row.tx_hash?.toLowerCase();
      const response = hash ? byHash.get(hash) : undefined;
      const action = hash
        ? byHand.get(hash)
        : row.source === "verify"
          ? calledByHand(row)
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
        sinceTime: (hash && timeOf.get(hash)) ?? null,
        txHash: row.tx_hash,
        actor: response
          ? {
              address: toTx(response.tx)?.from ?? null,
              is: "tripwire_response",
              responseId: response.id,
              rule: { id: response.rule_id, name: response.rule_name },
            }
          : action
            ? {
                address: null,
                is: "tripwire_manual",
                actionId: action.id,
                // Recorded as "username: note" by the actions route.
                by: action.note?.split(":")[0] ?? null,
                note: action.note,
              }
            : null,
        rules: row.source === "verify" ? confirming(row) : [],
      };
    });
  });
  done();
};
