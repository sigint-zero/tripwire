// Whether a contract's responses would work when a rule trips, and the
// pauses a person makes by hand (`RESPONSES.md`, Readiness and Pausing
// and unpausing by hand).

export const readinessSteps = [
  "signing_key",
  "rules",
  "registered",
  "operator",
  "permission",
  "least_power",
  "mode",
] as const;
export type ReadinessStepName = (typeof readinessSteps)[number];

export interface ReadinessStep {
  step: ReadinessStepName;
  /** `todo` on least power is a warning: it does not block. */
  state: "done" | "todo" | "not_applicable";
  detail: string;
}

/** What to send from the guardian's wallet to make the signing key an operator. */
export interface GuardianCall {
  /** The controller. */
  to: string;
  value: "0";
  data: string;
  /** The guardian, the only wallet that may send it. */
  from: string;
}

/** The last **Test the response** of one rule, kept until the next or a restart. */
export interface ResponseTest {
  ok: boolean;
  revertReason: string | null;
  gasEstimate: number | null;
  /** The key it would be sent from, and what that key holds. */
  sender: string | null;
  balanceWei: string | null;
  /** The call as the engine built it: `trip(Vault, 0x…)`. */
  function: string | null;
  args: string[];
  testedAt: string;
}

export interface Readiness {
  address: string;
  name: string;
  steps: ReadinessStep[];
  guardianCall: GuardianCall | null;
  /** Each enabled rule that acts on chain, with its last test. */
  rules: {
    id: string;
    name: string;
    action: "trip_global" | "trip_function" | "call";
    test: ResponseTest | null;
  }[];
}

/** A pause or unpause a person asks for from a contract's page. */
export type ManualAction =
  | {
      controller: "pause" | "unpause";
      scope: "contract" | "function";
      selector?: string;
      note?: string;
    }
  | {
      /** One of the contract's own functions, in signature form, with literal arguments. */
      call: { function: string; args: string[] };
      note?: string;
    };

/** A recorded manual action. */
export interface ManualActionItem {
  id: string;
  kind:
    | "trip_global"
    | "trip_function"
    | "reset_global"
    | "reset_function"
    | "call";
  target: string;
  selector: string | null;
  /** The called signature, for `call`. */
  function: string | null;
  args: string[] | null;
  note: string | null;
  status: string;
  error: string | null;
  txHash: string | null;
  createdAt: string;
}
