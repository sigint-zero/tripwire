import type { OnTrip } from "@tripwire/shared";
import { createHash } from "node:crypto";

// How the stand-in builds a response's transaction. Nothing is signed or
// sent: the values are shaped like the engine's so the Responses page
// reads the stand-in as it will read the engine.

/** The known controller deployment on Ethereum (`RESPONSES.md`). */
export const CONTROLLER = "0x328aed8f7a01f45a959c187f3cb97ec508064854";
/** The stand-in's pretend signing key. */
export const STUB_KEY = "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

const GAS_LIMIT = 65_000n;
const MAX_FEE_GWEI = 30n;
const MAX_PRIORITY_FEE_GWEI = 2n;
/** Without a cooldown on the rule, how long before another response is staged. */
export const DEFAULT_QUIET_SECONDS = 600;

export type OnChainAction = Exclude<OnTrip, { action: "notify" }>;

export function actsOnChain(onTrip: OnTrip): onTrip is OnChainAction {
  return onTrip.action !== "notify";
}

const fakeHash = (seed: string) =>
  `0x${createHash("sha256").update(seed).digest("hex")}`;

/** The transaction the engine would build for a rule's action. */
export function buildTx(onTrip: OnChainAction, target: string, nonce: number) {
  const call =
    onTrip.action === "trip_global"
      ? { to: CONTROLLER, function: "tripGlobal(address)", args: [target] }
      : onTrip.action === "trip_function"
        ? {
            to: CONTROLLER,
            function: "trip(address,bytes4)",
            args: [target, onTrip.function],
          }
        : {
            to: (onTrip.call.address ?? target).toLowerCase(),
            function: onTrip.call.function,
            args: onTrip.call.args,
          };
  return {
    ...call,
    from: STUB_KEY,
    value: onTrip.action === "call" ? (onTrip.call.value ?? "0") : "0",
    nonce,
    gas_limit: String(GAS_LIMIT),
    max_fee_gwei: String(MAX_FEE_GWEI),
    max_priority_fee_gwei: String(MAX_PRIORITY_FEE_GWEI),
    max_cost_wei: String(GAS_LIMIT * MAX_FEE_GWEI * 1_000_000_000n),
    hash: fakeHash(`${target}:${nonce}`),
    rebuilt: false,
    attempts: [] as {
      hash: string;
      max_fee_gwei: string;
      max_priority_fee_gwei: string;
      block: number;
    }[],
    block: null as number | null,
    gas_used: null as string | null,
  };
}

export type StubTx = ReturnType<typeof buildTx>;

/** The transaction once sent at `block`. */
export function submitted(tx: StubTx, block: number): StubTx {
  return {
    ...tx,
    attempts: [
      ...tx.attempts,
      {
        hash: tx.hash,
        max_fee_gwei: tx.max_fee_gwei,
        max_priority_fee_gwei: tx.max_priority_fee_gwei,
        block,
      },
    ],
  };
}

/** The transaction once included at `block`. */
export function confirmed(tx: StubTx, block: number): StubTx {
  return { ...tx, block, gas_used: "48213" };
}
