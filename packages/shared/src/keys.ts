// The keys Tripwire signs its responses with (`RESPONSES.md`, Keys). The
// engine holds them; the dashboard lists them and passes a passphrase
// through, never seeing key material.

/** A new key's passphrase: long enough that the keystore's encryption means something. */
export const MIN_PASSPHRASE = 12;

/** The largest keystore file an import takes. */
export const MAX_KEYSTORE_BYTES = 64 * 1024;

/** The longest name a key may be given. */
export const MAX_KEY_NAME = 60;

export interface KeyItem {
  /** Lowercase `0x` address. */
  address: string;
  /** What people call it; kept by the application, not the engine. */
  name: string | null;
  unlocked: boolean;
  /** Native balance at the current block, wei as a decimal string. */
  balanceWei: string;
  /** Whether responses are signed with it: the configured key, or else the only one. */
  signing: boolean;
  /**
   * Enabled rules whose trip would be signed with it: counted for the
   * signing key while the response mode is not `notify`, else 0. With the
   * key locked, none of them can respond.
   */
  neededBy: number;
  /** Registered contracts on the controller that name it an operator. */
  operatorOn: string[];
  /** Its keystore file, when the engine keeps it on disk. */
  file: string | null;
}

/** `GET /keys`. */
export interface KeyList {
  keys: KeyItem[];
  /** Where the keystore files are; null for the stand-in, which keeps them in its database. */
  directory: string | null;
}

/** `POST /keys` and `POST /keys/import`. */
export interface NewKey {
  address: string;
  file: string | null;
}

/** What a key may do to a registered contract, beyond sending to it. */
export interface KeyPower {
  contract: { address: string; name: string };
  /**
   * `owner`: the contract's `owner()`; `admin`: it holds
   * `DEFAULT_ADMIN_ROLE`; `operator`: the controller lets it pause the
   * contract.
   */
  power: "owner" | "admin" | "operator";
}

/** A transaction the engine sent from a key: a response, or an action taken by hand. */
export interface KeyTransaction {
  kind: "response" | "action";
  /** The response's or the action's id. */
  id: string;
  /** The rule that tripped, for a response; the person's note, for an action. */
  reason: string | null;
  /** What was called: a signature, or the controller's pause or unpause. */
  call: string;
  contract: { address: string; name: string | null };
  status: string;
  /** The latest attempt's hash. */
  hash: string;
  /** Where it was confirmed, and the gas it used there. */
  block: number | null;
  gasUsed: string | null;
  createdAt: string;
}

/** `GET /keys/:address`: one key, what it may do, and what it has sent. */
export interface KeyDetail {
  key: KeyItem;
  powers: KeyPower[];
  /** Why the contracts' owners and roles could not be read, when they could not. */
  powersProblem: string | null;
  /** Newest first. */
  transactions: KeyTransaction[];
  /**
   * Transactions that do not name their sender, while more than one key
   * exists: they may be this key's and are not listed.
   */
  unattributed: number;
}
