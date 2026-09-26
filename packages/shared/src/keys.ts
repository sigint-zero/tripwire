// The keys Tripwire signs its responses with (`RESPONSES.md`, Keys). The
// engine holds them; the dashboard lists them and passes a passphrase
// through, never seeing key material.

/** A new key's passphrase: long enough that the keystore's encryption means something. */
export const MIN_PASSPHRASE = 12;

/** The largest keystore file an import takes. */
export const MAX_KEYSTORE_BYTES = 64 * 1024;

export interface KeyItem {
  /** Lowercase `0x` address. */
  address: string;
  unlocked: boolean;
  /** Native balance at the current block, wei as a decimal string. */
  balanceWei: string;
  /** Whether responses are signed with it: the only key, until one is chosen. */
  signing: boolean;
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
