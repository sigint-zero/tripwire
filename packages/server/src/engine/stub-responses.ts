import type { OnTrip } from "@tripwire/shared";
import { createHash } from "node:crypto";
import { toFunctionSelector } from "viem";

// How the stand-in builds a response's transaction. Nothing is signed or
// sent: the values are shaped like the engine's so the Responses page
// reads the stand-in as it will read the engine.

/** The known controller deployment on Ethereum (`RESPONSES.md`). */
export const CONTROLLER = "0x328aed8f7a01f45a959c187f3cb97ec508064854";
/** The guardian every contract registers with the stand-in's controller: the owner's wallet. */
export const GUARDIAN = "0x7e57000000000000000000000000000000000001";

const GAS_LIMIT = 65_000n;
const GWEI = 1_000_000_000n;
const MAX_FEE = 30n * GWEI;
const MAX_PRIORITY_FEE = 2n * GWEI;
/** Without a cooldown on the rule, how long before another response is staged. */
export const DEFAULT_QUIET_SECONDS = 600;

export type OnChainAction = Exclude<OnTrip, { action: "notify" }>;

export function actsOnChain(onTrip: OnTrip): onTrip is OnChainAction {
  return onTrip.action !== "notify";
}

const fakeHash = (seed: string) =>
  `0x${createHash("sha256").update(seed).digest("hex")}`;

/**
 * The transaction the engine would build for a rule's action, in its
 * `responses.tx` form: fees in wei, the arguments as decoded text.
 */
export function buildTx(onTrip: OnChainAction, target: string, nonce: number) {
  const call =
    onTrip.action === "trip_global"
      ? {
          target: CONTROLLER,
          function: "tripGlobal(address)",
          decoded_args: [target],
        }
      : onTrip.action === "trip_function"
        ? {
            target: CONTROLLER,
            function: "trip(address,bytes4)",
            decoded_args: [target, toFunctionSelector(onTrip.function)],
          }
        : {
            target: (onTrip.call.address ?? target).toLowerCase(),
            function: onTrip.call.function,
            decoded_args: onTrip.call.args,
          };
  return {
    ...call,
    value: onTrip.action === "call" ? (onTrip.call.value ?? "0") : "0",
    nonce,
    gas_limit: String(GAS_LIMIT),
    max_fee_per_gas: String(MAX_FEE),
    max_priority_fee_per_gas: String(MAX_PRIORITY_FEE),
    hash: fakeHash(`${target}:${nonce}`),
    attempts: [] as {
      hash: string;
      max_fee_per_gas: string;
      max_priority_fee_per_gas: string;
      submitted_block: number;
    }[],
    approval_rebuilt: false,
  };
}

export type StubTx = ReturnType<typeof buildTx> & {
  confirmed_block?: number;
  gas_used?: string;
};

/** The transaction once sent at `block`. */
export function submitted(tx: StubTx, block: number): StubTx {
  return {
    ...tx,
    attempts: [
      ...tx.attempts,
      {
        hash: tx.hash,
        max_fee_per_gas: tx.max_fee_per_gas,
        max_priority_fee_per_gas: tx.max_priority_fee_per_gas,
        submitted_block: block,
      },
    ],
  };
}

/** The transaction once included at `block`. */
export function confirmed(tx: StubTx, block: number): StubTx {
  return { ...tx, confirmed_block: block, gas_used: "48213" };
}
